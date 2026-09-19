import { mutualGroupWithCategory, normalizeKey } from '@/utils/promptPolicy'
import type { usePromptBuilderStore } from '@/stores/promptBuilderStore'
import { defaultOutfit, findBlueprint, findCharacter, findOutfit } from '@/utils/popularContent'

export async function applyInterrogateResult(pb: ReturnType<typeof usePromptBuilderStore>, result: unknown) {
  if (!result || typeof result !== 'object') return
  const { characterConflictNote, collectInterrogateContext, mergeInterrogatedTags } = await import('@/utils/interrogateMerge')
  const payload = result as { mode?: string; caption?: string; tags?: unknown; characterTags?: unknown; warning?: string }
  if (payload.mode === 'caption' && typeof payload.caption === 'string' && payload.caption.trim()) {
    pb.visualDescription = String(payload.caption).trim()
    pb.flash('自然语言已填入画面描述；请核对人物外观与服装，散文中的语义冲突仍需人工确认')
    const warning = payload.warning
    if (warning) setTimeout(() => pb.flash(warning), 2600)
    return
  }
  const tags: string[] = Array.isArray(payload.tags) ? payload.tags.filter((tag): tag is string => typeof tag === 'string') : []
  const characterTags: string[] = Array.isArray(payload.characterTags) ? payload.characterTags.filter((tag): tag is string => typeof tag === 'string') : []
  // 三重去重 + 身份域冲突消解（studio：charPrompt+场景行；popular：角色词条+蓝图行）
  const subject = pb.subject
  const popularChar = subject.kind === 'popular' ? findCharacter(pb.popularCharacters, subject.characterId) : null
  const context = collectInterrogateContext(subject.kind === 'popular'
    ? {
        kind: 'popular',
        character: popularChar
          ? {
              identityTokens: popularChar.identityTokens,
              exactTokens: popularChar.exactTokens,
              aliases: popularChar.aliases,
              outfitTokens: pb.outfitOverride?.tokens ?? (findOutfit(popularChar, subject.outfitId) ?? defaultOutfit(popularChar))?.tokens,
            }
          : null,
        blueprintTokens: subject.blueprintId ? findBlueprint(pb.sceneBlueprints, subject.blueprintId)?.promptTokens ?? [] : [],
      }
    : {
        kind: 'studio',
        charPrompt: pb.charPrompt,
        scenePrompt: pb.activeScene?.prompt,
        sceneTags: pb.activeScene?.tags,
      })
  const merged = mergeInterrogatedTags({
    tags,
    manualTags: pb.manualTags,
    identityTokens: context.identityTokens,
    sceneTokens: context.sceneTokens,
    shot: pb.selections.shot,
    replaceOutfit: subject.kind === 'popular',
  })
  const next = new Set([...pb.manualTags])
  // 1. 自动清理与参考图姿势/神态/鞋袜冲突的旧手动词条
  for (const obsolete of merged.obsoleteManualTags) {
    next.delete(obsolete)
    const norm = normalizeKey(obsolete)
    for (const t of next) {
      if (normalizeKey(t) === norm) next.delete(t)
    }
  }
  // 2. 注入新采纳的参考图词条（姿势、动作、服饰细节等）
  for (const acc of merged.accepted) {
    next.add(acc)
  }
  // 3. 服装跨族顶替（popular 模式整体替换 outfit）
  if (subject.kind === 'popular' && merged.outfitReplacement.length) {
    const group = mutualGroupWithCategory(merged.outfitReplacement[0])?.group
    for (const tag of next) { const hit = mutualGroupWithCategory(tag); if (hit?.category === 'outfit' && hit.group !== group) next.delete(tag) }
    pb.setOutfitOverride(merged.outfitReplacement, merged.replacedOutfitGroup)
  }
  pb.manualTags = next
  const note = characterConflictNote(characterTags, context.identityTokens, context.aliases)
  const parts: string[] = []
  if (merged.restorations.length) {
    parts.push(merged.restorations.join('；'))
  }
  if (merged.outfitReplacement.length) {
    const from = merged.replacedOutfitGroup ? `（原${merged.replacedOutfitGroup}）` : ''
    parts.push(`已采用参考图服装顶替角色默认服装${from}：${merged.outfitReplacement.slice(0, 3).join('、')}`)
  }
  const modelSuffix = typeof (payload as { model?: unknown }).model === 'string' && (payload as { model?: string }).model ? `（${(payload as { model?: string }).model}）` : ''
  if (merged.accepted.length) parts.push(`已叠加 ${merged.accepted.length} 个参考图词条${modelSuffix}，可切人直出`)
  if (merged.obsoleteManualTags.length) parts.push(`已自动清理冲突旧词条 ${merged.obsoleteManualTags.length} 个`)
  if (merged.duplicates.length) parts.push(`跳过已有词条 ${merged.duplicates.length} 个`)
  if (merged.filtered.length) parts.push(`已自动过滤打码与元数据标签 ${merged.filtered.length} 个`)
  if (merged.conflicts.length) {
    // 只列 tag 名（swimsuit）用户看不懂为什么被拦，故优先展示 reason
    // （含「反推出什么 / 当前是什么 / 怎么改」）。冲突含身份域与互斥组两类。
    const first = merged.conflicts[0]
    const detail = merged.conflicts.length === 1
      ? first.reason
      : `${first.reason} 等 ${merged.conflicts.length} 项`
    parts.push(`跳过身份冲突 ${merged.conflicts.length} 个：${detail}`)
  }
  if (note) parts.push(note)
  pb.flash(parts.length ? parts.join('；') : '反推完成，无新增词条')
  const warning = payload.warning
  if (warning) setTimeout(() => pb.flash(warning), 2600)
}

