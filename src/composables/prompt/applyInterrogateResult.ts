import { normalizeKey, tokenize } from '@/utils/promptPolicy'
import { LIGHTING, SHOT, STUDIO_PROMPT_SUBJECTS } from '@/config/promptConstants'
import { animaArtistTag } from '@/config/artistStyles'
import { cloneReferenceInput } from '@/utils/promptBuilderPersistence'
import type { usePromptBuilderStore } from '@/stores/promptBuilderStore'
import { defaultOutfit, findBlueprint, findCharacter, findOutfit } from '@/utils/popularContent'
import { isOutfitToken, standaloneIdentityTokens } from '@/utils/popularIdentity'
import { resolveFreeInterrogateTags } from '@/utils/interrogateFree'
import { parseAssistLayout, type InterrogateResult } from '@/api/interrogateResult'
import { referenceCharacterCount } from '@/utils/promptCast'
import { CHAR_PROMPT } from '@/config/promptConstants'

export async function applyInterrogateResult(pb: ReturnType<typeof usePromptBuilderStore>, result: unknown, current: () => boolean = () => true, usingMoss = false) {
  if (!current() || !result || typeof result !== 'object') return
  if ((result as { engine?: string }).engine === 'heuristic') {
    pb.flash('反推暂不可用，请稍后重试')
    return
  }
  const payload = result as Partial<InterrogateResult>
  function flash(message: string, captionAdopted = false, boundAssist = false) {
    const assistLabel = payload.assistProvider === 'chatgpt' ? ' ChatGPT' : '聊天 API'
    const assistNote = payload.assistUsed && captionAdopted
      ? `；已通过${assistLabel}协同补全${boundAssist ? '动作与环境描述' : '描述'}`
      : ''
    if (payload.warning) pb.flash(`${payload.warning}；${message}`, 5200, 'warning')
    else pb.flash(`${message}${assistNote}`)
  }
  const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((tag): tag is string => typeof tag === 'string' && Boolean(tag.trim())).map(tag => tag.trim()) : []
  const rawTags = strings(payload.tags), characterTags = strings(payload.characterTags)
  const copyrightTags = strings(payload.copyrightTags)
  const rawCaption = typeof payload.caption === 'string' ? payload.caption.trim() : ''
  const sourceIdentityTerms = [...new Set([...characterTags, ...copyrightTags])]
  const subjectMode = payload.assistSubjectMode ?? (pb.isUnbound ? 'free' : 'bound')
  const tagMetadata = payload.mode === 'tag' || usingMoss
  const artistTags = tagMetadata ? strings(payload.styleTags).map(animaArtistTag) : []
  const { isCensorTag, characterConflictNote, collectInterrogateContext, mergeInterrogatedTags } = await import('@/utils/interrogateMerge')
  if (!current()) return
  if (pb.isUnbound) {
    const resolved = resolveFreeInterrogateTags(rawTags, payload.scores, characterTags)
    // Older runtimes lack copyright predictions. Only use an explicit catalogue mapping as fallback.
    const characterKeys = new Set(characterTags.map(normalizeKey))
    const works = copyrightTags.length ? copyrightTags : [...Object.values(STUDIO_PROMPT_SUBJECTS), ...pb.popularCharacters]
      .filter(subject => subject.characterTokens?.some(tag => characterKeys.has(normalizeKey(tag))))
      .flatMap(subject => subject.copyrightTokens ?? [])
    const rating = (['general', 'sensitive', 'questionable', 'explicit'] as const)
      .map(key => [key, payload.rating?.[key]] as const)
      .filter((item): item is readonly [keyof InterrogateResult['rating'], number] => typeof item[1] === 'number' && Number.isFinite(item[1]) && item[1] > 0 && item[1] <= 1)
      .sort((a, b) => b[1] - a[1])[0]?.[0]
    const source = [...new Set([...resolved.tags, ...characterTags, ...works, ...artistTags])]
    const tags = source.filter(tag => !isCensorTag(tag))
    const caption = (payload.mode === 'caption' || payload.assistUsed) && !payload.captionDerived && typeof payload.caption === 'string' ? payload.caption.trim() : ''
    const layout = payload.assistUsed ? parseAssistLayout(payload.assistLayout) : null
    if (!tags.length && !caption && !layout) { flash('未找到可采用的反推内容，请调整阈值后重试'); return }
    if (tagMetadata && rating && tags.length) tags.unshift(rating === 'general' ? 'safe' : rating)
    const prior = pb.referenceInput
    const unchangedCaption = prior?.captionInEditor && pb.visualDescription === prior.caption
    const handwritten = usingMoss && !unchangedCaption ? pb.visualDescription : ''
    pb.clearScene({ keepStory: true })
    pb.setArtistStyleIds([])
    if (!usingMoss) pb.sdParams.negativeCustom = ''
    pb.manualTags = new Set(tags)
    pb.referenceInput = cloneReferenceInput({ tags, characterTokens: characterTags, copyrightTokens: works,
      rawTags, rawCaption, sourceIdentityTerms, subjectMode, caption,
      captionInEditor: Boolean(caption && !usingMoss), ...(layout ? { layout } : {}) })
    pb.visualDescription = usingMoss ? handwritten : caption
    pb.concise = false
    const filtered = source.filter(isCensorTag).length
    const adopted = [caption && '原图描述', tags.length && `${tags.length} 个原图词条`].filter(Boolean).join('和') || '原图布局'
    flash(`已采用${adopted}${usingMoss && layout ? `；已识别 ${layout.items.length} 个布局区域` : ''}${handwritten.trim() ? '；已保留手写说明' : ''}${filtered ? `；已去除 ${filtered} 个马赛克、遮挡或噪点词条` : ''}${resolved.removed.length ? `；已略去 ${resolved.removed.length} 个置信度明显较低的冲突词条` : ''}`, Boolean(caption))
    return
  }
  const { isReferenceWardrobeTag, splitReferenceTags } = await import('@/utils/interrogateReference')
  if (!current()) return
  const castCharacters = pb.cast.flatMap(member => member.source === 'studio' ? [] :
    pb.popularCharacters.filter(character => character.id === member.characterId))
  const castAliases = [...Object.values(STUDIO_PROMPT_SUBJECTS).flatMap(character => character.characterTokens),
    ...castCharacters.flatMap(character => [...character.identityTokens, character.displayName, character.originalName])]
  const reference = splitReferenceTags(rawTags, {
    knownCharacterTags: [...characterTags, ...copyrightTags, ...castAliases,
      ...pb.popularCharacters.flatMap(character => [...character.exactTokens, ...character.aliases])],
    catalog: pb.tags,
  })
  const assistCaption = payload.assistUsed && payload.assistSubjectMode === 'bound'
    && !payload.captionDerived && typeof payload.caption === 'string' ? payload.caption.trim() : ''
  const assistLayout = payload.assistUsed ? parseAssistLayout(payload.assistLayout) : null
  const characterBoxes = referenceCharacterCount(assistLayout)
  // A free caption can mix identity with clothes and scenery. Only structured tags
  // and bound-mode de-identified assist prose/layout enter the transferable layer;
  // never overwrite the user's own prose.
  if (!reference.tags.length && !artistTags.length && !assistCaption && !assistLayout) {
    flash('未找到可安全套用的非身份词条；人物特征与无法拆分的描述未写入，请核对后手动补充衣服、姿势或背景')
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
  const castIdentity = [...context.identityTokens, ...castCharacters.flatMap(character => character.identityTokens),
    ...pb.cast.filter(member => member.source === 'studio').flatMap(member => tokenize(CHAR_PROMPT[member.characterId]))]
  const priorReference = new Set((pb.referenceInput?.tags ?? []).map(normalizeKey))
  const userTags = new Set([...pb.manualTags].filter(tag => !priorReference.has(normalizeKey(tag))))
  const referenceArtists = pb.artistStyleIds.length || [...userTags].some(tag => normalizeKey(tag).startsWith('@')) ? [] : artistTags
  // The new picture replaces the previous reference layer, never unrelated
  // explicit user edits. The target's identity is supplied only by its own data.
  const identityOnly = standaloneIdentityTokens(castIdentity)
  const inheritedShot = pb.directorSources.shot === 'scene'
  const inheritedLighting = pb.directorSources.lighting === 'scene'
  // Explicit director choices participate in the same conflict rules as manual
  // edits. Inherited scene defaults will be cleared below, so cannot veto the reference.
  const protectedTags = new Set([
    ...userTags,
    ...tokenize(!inheritedShot ? SHOT.find(option => option.id === pb.selections.shot)?.prompt ?? '' : ''),
    ...tokenize(!inheritedLighting ? LIGHTING.find(option => option.id === pb.selections.lighting)?.prompt ?? '' : ''),
  ])
  const merged = mergeInterrogatedTags({
    tags: characterBoxes >= 2 ? reference.tags.filter(tag => !isReferenceWardrobeTag(tag) && !isOutfitToken(tag)) : reference.tags,
    manualTags: protectedTags,
    protectedManualTags: protectedTags,
    identityTokens: subject.kind === 'popular' ? identityOnly : castIdentity,
    sceneTokens: [],
    shot: inheritedShot ? null : pb.selections.shot,
    replaceOutfit: subject.kind === 'popular',
  })
  const next = new Set(userTags)
  const accepted = new Set(merged.accepted)
  const rejected = new Set([...merged.conflicts.map(item => item.tag), ...merged.filtered])
  // Capture even clothing duplicated by the current role. Otherwise switching
  // to a different role would lose same-family clothes, shirts or coats.
  const referenceOutfit = subject.kind === 'popular' && characterBoxes < 2 ? reference.tags.filter(tag => {
    const key = normalizeKey(tag)
    return !rejected.has(key) && isOutfitToken(key)
  }).map(normalizeKey) : []
  for (const tag of accepted) if (!referenceOutfit.includes(tag)) next.add(tag)
  for (const tag of referenceArtists) next.add(tag)
  if (!accepted.size && !referenceOutfit.length && !referenceArtists.length && !assistCaption && !assistLayout) {
    flash('参考词条与现有设置重复或冲突，已保留当前手动设置')
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
  pb.clearInheritedDirectorValues()
  if (subject.kind === 'popular') {
    if (referenceOutfit.length) pb.setOutfitOverride(referenceOutfit, merged.replacedOutfitGroup)
    else if (!pb.outfitOverride?.presetId) pb.clearOutfitOverride()
  }
  // A newly interrogated reference supplies each mapped slot's clothing by default;
  // clear prior explicit outfit overrides so reference outfits take effect immediately.
  if (assistLayout && characterBoxes >= pb.cast.length && pb.cast.length > 0) {
    pb.cast.forEach((member, index) => {
      if (member.source !== 'custom' && (member.outfitExplicit || member.outfitId === 'custom' || member.outfitId === 'none')) {
        pb.updateCastMember(index, { outfitId: '', outfitExplicit: false, outfitPrompt: undefined })
      }
    })
  } else if (pb.cast.length === 1 && pb.cast[0]?.source !== 'custom' && pb.cast[0]?.outfitExplicit) {
    pb.updateCastMember(0, { outfitId: '', outfitExplicit: false, outfitPrompt: undefined })
  }
  pb.manualTags = next
  const userKeys = new Set([...userTags].map(tag => normalizeKey(pb.tagDictionary.canonicalize(tag))))
  const sourceTags = [...pb.manualTags].filter(tag => !userKeys.has(normalizeKey(tag)))
  pb.referenceInput = cloneReferenceInput({
    tags: sourceTags, subjectMode, rawTags, rawCaption, sourceIdentityTerms,
    characterTokens: characterTags, copyrightTokens: copyrightTags,
    ...(assistCaption ? { caption: assistCaption, captionInEditor: false } : {}),
    ...(assistLayout ? { layout: assistLayout } : {}),
  })
  const note = characterConflictNote(characterTags, castIdentity, [...context.aliases, ...castAliases,
    ...castCharacters.flatMap(character => character.aliases)])
  const adoptedTagCount = new Set([...accepted, ...referenceOutfit, ...referenceArtists]).size
  const parts = [adoptedTagCount
    ? `已采用 ${adoptedTagCount} 个参考词条，可连续切换角色；人物身份跟随目标角色`
    : `已采用参考${assistCaption ? '画面描述' : '画面布局'}，可连续切换角色；人物身份跟随目标角色`]
  if (usingMoss && assistLayout) parts.push(`已识别 ${assistLayout.items.length} 个布局区域`)
  const castSize = pb.cast.length
  if (usingMoss && characterBoxes > castSize && castSize) {
    parts.push(`参考图有 ${characterBoxes} 位人物，可添加同框角色替换其余位置`)
  } else if (castSize > 1 && characterBoxes < castSize) {
    parts.push(usingMoss ? '将保留参考图氛围并为演员表重新站位' : '保留参考图氛围，各角色使用自己的服装')
  }
  if (referenceOutfit.length) parts.push('参考服装已独立保留')
  if (referenceArtists.length) parts.push('反推画师已放入画师段')
  if (reference.excludedIdentity.length) parts.push(`已排除参考人物特征 ${reference.excludedIdentity.length} 项`)
  if (reference.uncertain.length) parts.push(`另有 ${reference.uncertain.length} 项描述无法可靠区分，未自动套用`)
  if (assistCaption) {
    if (pb.visualDescription.trim()) parts.push('已保留手写画面描述')
  } else if (payload.mode === 'caption') {
    parts.push('已采用结构化标签，原始散文未覆盖手写画面描述')
  }
  if (merged.conflicts.length) parts.push(`保留现有设置，跳过冲突词条 ${merged.conflicts.length} 项：${merged.conflicts[0].reason}`)
  if (merged.filtered.length) parts.push(`过滤噪点或元数据 ${merged.filtered.length} 项`)
  if (note) parts.push(note)
  flash(parts.join('；'), Boolean(assistCaption), true)
}
