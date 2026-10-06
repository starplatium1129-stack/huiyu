import { mutualGroupWithCategory, normalizeKey, tokenize } from '@/utils/promptPolicy'
import { LIGHTING, SHOT } from '@/config/promptConstants'
import type { usePromptBuilderStore } from '@/stores/promptBuilderStore'
import { defaultOutfit, findBlueprint, findCharacter, findOutfit } from '@/utils/popularContent'
import { isGarmentToken, standaloneIdentityTokens } from '@/utils/popularIdentity'
import { inferBlueprintDecisions } from '@/utils/popularBlueprintDecisions'
import { sceneStyleBaseline } from '@/utils/randomVariationContext'

export async function applyInterrogateResult(pb: ReturnType<typeof usePromptBuilderStore>, result: unknown) {
  if (!result || typeof result !== 'object') return
  if ((result as { engine?: string }).engine === 'heuristic') {
    pb.flash('本地反推模型不可用，演示标签未写入工作台，请检查 WD14 模型后重试')
    return
  }
  const { characterConflictNote, collectInterrogateContext, mergeInterrogatedTags } = await import('@/utils/interrogateMerge')
  const { splitReferenceTags } = await import('@/utils/interrogateReference')
  const payload = result as { mode?: string; caption?: string; tags?: unknown; characterTags?: unknown; warning?: string }
  const rawTags = Array.isArray(payload.tags) ? payload.tags.filter((tag): tag is string => typeof tag === 'string') : []
  const characterTags = Array.isArray(payload.characterTags) ? payload.characterTags.filter((tag): tag is string => typeof tag === 'string') : []
  const reference = splitReferenceTags(rawTags, {
    knownCharacterTags: [...characterTags, ...pb.popularCharacters.flatMap(character => [...character.exactTokens, ...character.aliases])],
    catalog: pb.tags,
  })
  // A free caption can mix identity with clothes and scenery. Only structured
  // tags enter the transferable layer; never overwrite the user's own prose.
  if (!reference.tags.length) {
    pb.flash('未找到可安全套用的非身份词条；人物特征与无法拆分的描述未写入，请核对后手动补充衣服、姿势或背景')
    return
  }
  const subject = pb.subject
  const popularChar = subject.kind === 'popular' ? findCharacter(pb.popularCharacters, subject.characterId) : null
  const blueprint = subject.kind === 'popular' && subject.blueprintId ? findBlueprint(pb.sceneBlueprints, subject.blueprintId) : null
  const studioScene = subject.kind === 'studio' ? pb.activeScene : null
  const context = collectInterrogateContext(subject.kind === 'popular'
    ? { kind: 'popular', character: popularChar ? {
        identityTokens: popularChar.identityTokens,
        exactTokens: popularChar.exactTokens,
        aliases: popularChar.aliases,
        outfitTokens: pb.outfitOverride?.tokens ?? (findOutfit(popularChar, subject.outfitId) ?? defaultOutfit(popularChar))?.tokens,
      } : null }
    : { kind: 'studio', charPrompt: pb.charPrompt })
  const priorReference = new Set((pb.referenceInput?.tags ?? []).map(normalizeKey))
  const userTags = new Set([...pb.manualTags].filter(tag => !priorReference.has(normalizeKey(tag))))
  // The new picture replaces the previous reference layer, never unrelated
  // explicit user edits. The target's identity is supplied only by its own data.
  const identityOnly = standaloneIdentityTokens(context.identityTokens)
  const decision = blueprint ? inferBlueprintDecisions(blueprint) : studioScene ? sceneStyleBaseline(studioScene) : null
  const inheritedShot = decision && pb.selections.shot === decision.shot
  const inheritedLighting = decision && pb.selections.lighting === decision.lighting
  // Explicit director choices participate in the same conflict rules as manual
  // edits. Inherited scene defaults will be cleared below, so cannot veto the reference.
  const protectedTags = new Set([
    ...userTags,
    ...tokenize(!inheritedShot ? SHOT.find(option => option.id === pb.selections.shot)?.prompt ?? '' : ''),
    ...tokenize(!inheritedLighting ? LIGHTING.find(option => option.id === pb.selections.lighting)?.prompt ?? '' : ''),
  ])
  const merged = mergeInterrogatedTags({
    tags: reference.tags,
    manualTags: protectedTags,
    protectedManualTags: protectedTags,
    identityTokens: subject.kind === 'popular' ? identityOnly : context.identityTokens,
    sceneTokens: [],
    shot: inheritedShot ? null : pb.selections.shot,
    replaceOutfit: subject.kind === 'popular',
  })
  const next = new Set(userTags)
  const accepted = new Set(merged.accepted)
  const rejected = new Set([...merged.conflicts.map(item => item.tag), ...merged.filtered])
  // Capture even clothing duplicated by the current role. Otherwise switching
  // to a different role would lose same-family clothes, shirts or coats.
  const referenceOutfit = subject.kind === 'popular' ? reference.tags.filter(tag => {
    const key = normalizeKey(tag)
    return !rejected.has(key) && (isGarmentToken(key) || mutualGroupWithCategory(key)?.category === 'outfit')
  }).map(normalizeKey) : []
  for (const tag of accepted) if (!referenceOutfit.includes(tag)) next.add(tag)
  if (!accepted.size && !referenceOutfit.length) {
    pb.flash('参考词条与现有设置重复或冲突，已保留当前手动设置')
    return
  }
  // A reference replaces inherited rendering input in both subject modes.
  // Detach the studio scene only after accepting transferable tags; retain
  // handwritten prose, edited story and explicit edits, retiring inherited story.
  if (studioScene) {
    const style = pb.snapshotStyleLayers(), description = pb.visualDescription
    pb.clearScene({ keepStory: pb.story !== pb.sceneBaseStory })
    pb.restoreStyleLayers({ ...style, randomVariation: null, referenceInput: null })
    pb.visualDescription = description
  }
  if (blueprint) pb.setPopularBlueprint(null)
  if (decision) {
    if (inheritedShot) pb.setShot(null)
    if (inheritedLighting) pb.setLighting(null)
    if (pb.selections.composition === decision.composition) pb.setComposition(null)
    if (pb.colorMood === decision.colorMood) pb.setColorMood(null)
  }
  if (subject.kind === 'popular') {
    if (referenceOutfit.length) pb.setOutfitOverride(referenceOutfit, merged.replacedOutfitGroup)
    else pb.clearOutfitOverride()
  }
  pb.manualTags = next
  const userKeys = new Set([...userTags].map(tag => normalizeKey(pb.tagDictionary.canonicalize(tag))))
  const sourceTags = [...pb.manualTags].filter(tag => !userKeys.has(normalizeKey(tag)))
  pb.referenceInput = sourceTags.length ? { tags: sourceTags } : null
  const note = characterConflictNote(characterTags, context.identityTokens, context.aliases)
  const parts = [`已采用 ${accepted.size + referenceOutfit.filter(tag => !accepted.has(tag)).length} 个参考词条，可连续切换角色；人物身份跟随目标角色`]
  if (referenceOutfit.length) parts.push('参考服装已独立保留')
  if (reference.excludedIdentity.length) parts.push(`已排除参考人物特征 ${reference.excludedIdentity.length} 项`)
  if (reference.uncertain.length) parts.push(`另有 ${reference.uncertain.length} 项描述无法可靠区分，未自动套用`)
  if (payload.mode === 'caption') parts.push('已采用结构化标签，原始散文未覆盖手写画面描述')
  if (merged.conflicts.length) parts.push(`保留现有设置，跳过冲突词条 ${merged.conflicts.length} 项：${merged.conflicts[0].reason}`)
  if (merged.filtered.length) parts.push(`过滤噪点或元数据 ${merged.filtered.length} 项`)
  if (note) parts.push(note)
  pb.flash(parts.join('；'))
  if (payload.warning) setTimeout(() => pb.flash(payload.warning!), 2600)
}
