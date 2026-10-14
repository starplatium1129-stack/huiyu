import { toRaw } from 'vue'
import { CHAR_PROMPT, usePromptBuilderStore } from '@/stores/promptBuilderStore'
import type { UnifiedPromptAssemblyState } from '@/composables/useUnifiedPromptAssembly'
import type { InterrogateResult } from '@/api/interrogateResult'
import type { ResultContextInput } from '@/utils/resultContext'
import type { AnimaGenerationState } from '@/types/anima'
import { defaultOutfit, findCharacter, findOutfit } from '@/utils/popularContent'
import { characterControlTokens, isManualR18Tags, mutualGroupWithCategory, normalizeKey } from '@/utils/promptPolicy'
import { plainEnglish } from '@/utils/promptCompiler'
import { collectInterrogateContext, mergeInterrogatedTags } from '@/utils/interrogateMerge'
import { isGarmentToken, standaloneIdentityTokens } from '@/utils/popularIdentity'
import { splitReferenceTags } from '@/utils/interrogateReference'
import { isLocalStudioHost } from '@/utils/runtimeEnvironment'

export interface CompanionImageArgs {
  character: string; description: string; visualDescription?: string; outfit?: string; mature?: boolean
}
export type CompanionPromptDraft = UnifiedPromptAssemblyState & ResultContextInput & { story: string }
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(toRaw(value))) as T

export function validateCompanionImageArgs(args: CompanionImageArgs, reference: boolean): void {
  if (!args || typeof args.character !== 'string' || !args.character.trim() || args.character.length > 80
    || typeof args.description !== 'string' || !args.description.trim() || args.description.length > 1200
    || (args.outfit !== undefined && (typeof args.outfit !== 'string' || !args.outfit.trim() || args.outfit.length > 100))
    || (args.mature !== undefined && typeof args.mature !== 'boolean')
    || (args.visualDescription !== undefined && (typeof args.visualDescription !== 'string' || args.visualDescription.length > 8000))) throw new Error('绘图参数无效，请重新描述角色与画面')
  const visual = args.visualDescription?.trim() || ''
  if (visual && !plainEnglish(visual)) throw new Error('画面描述需要使用英文，请让桌宠重新整理描述')
  if (!reference && !visual) throw new Error('缺少英文画面描述，请让桌宠重新整理描述')
}

/** A detached compiler input: generating in chat never changes the workbench's handwritten draft. */
export function companionPromptDraft(pb: ReturnType<typeof usePromptBuilderStore>, args: CompanionImageArgs,
  state: AnimaGenerationState, inferred?: InterrogateResult, report?: (message: string) => void): CompanionPromptDraft {
  const studio = args.character === 'nene' || args.character === 'natsume'
  const character = studio ? null : findCharacter(pb.popularCharacters, args.character)
  if (!studio && !character) throw new Error('该桌宠尚未绑定工作台角色，请先补齐角色配置')
  const requestedOutfit = args.outfit?.trim() || 'default'
  const outfit = character ? requestedOutfit === 'default' ? defaultOutfit(character)
    : findOutfit(character, requestedOutfit) || character.outfits.find(item => item.name === requestedOutfit) : null
  if (character && !outfit) throw new Error('这套服装未在当前角色目录中找到，请选择已配置的服装')
  if (studio && requestedOutfit !== 'default' && !/^[a-z0-9_ -]+$/i.test(requestedOutfit)) throw new Error('工作室角色服装需要使用英文服装词条')
  const matureTokens = new Set(pb.tags.filter(tag => tag.cat === 'Mature').map(tag => normalizeKey(tag.en)))
  const visual = args.visualDescription?.trim() || (plainEnglish(args.description) ? args.description.trim() : '')
  const mature = args.mature === true || requestedOutfit === 'nsfw_nude'
    || isManualR18Tags([requestedOutfit, ...visual.split(/[\s,;.]+/), ...(inferred?.tags ?? [])], matureTokens)
    || Boolean(inferred && Math.max(inferred.rating.questionable, inferred.rating.explicit) > Math.max(inferred.rating.general, inferred.rating.sensitive))
  if (mature && (!isLocalStudioHost() || !pb.showMatureScenes || character && character.adultEligibility !== 'adult')) throw new Error('当前角色、题材开关或本机环境未获得成人题材授权')
  const char = studio ? args.character as 'nene' | 'natsume' : pb.char
  const manual = new Set<string>()
  if (studio && requestedOutfit !== 'default') {
    const token = requestedOutfit === 'nsfw_nude' ? 'nude' : normalizeKey(requestedOutfit)
    const controls = characterControlTokens({ prompt: token, tags: [token], rating: mature ? 'R18' : 'All' }, char, { [char]: state.loraId })
    for (const value of controls.length ? controls : [token]) manual.add(value)
  }
  if (mature) manual.add('nsfw')
  const draft: CompanionPromptDraft = {
    char, charPrompt: CHAR_PROMPT[char], subject: character && outfit
      ? { kind: 'popular', characterId: character.id, outfitId: outfit.id, blueprintId: null } : { kind: 'studio' },
    isPopular: Boolean(character), sceneId: null, activeScene: null, story: args.description.trim(), visualDescription: visual,
    artistStyleIds: [...pb.artistStyleIds], directorMode: pb.directorMode, colorMood: null, concise: pb.concise, emotionPrompt: '',
    manualTags: manual, randomVariation: null, selections: { emotion: [], shot: null, lighting: null, composition: null },
    characters: copy(pb.characters), loraMeta: copy(pb.loraMeta), modelProfiles: copy(pb.modelProfiles), tags: copy(pb.tags),
    popularCharacters: copy(pb.popularCharacters), sceneBlueprints: [], outfitOverride: null,
    sdModelName: pb.sdModelName, sdParams: copy(pb.sdParams), projectId: pb.projectId, showMatureScenes: mature,
  }
  if (!inferred) return draft
  const reference = splitReferenceTags(inferred.tags, {
    knownCharacterTags: [...inferred.characterTags, ...pb.popularCharacters.flatMap(item => [...item.exactTokens, ...item.aliases])], catalog: draft.tags,
  })
  const identity = collectInterrogateContext(character ? { kind: 'popular', character: {
    identityTokens: character.identityTokens, exactTokens: character.exactTokens, aliases: character.aliases, outfitTokens: outfit?.tokens,
  } } : { kind: 'studio', charPrompt: draft.charPrompt })
  // An explicit outfit is a user instruction. Default clothes may be replaced by the reference layer.
  const protectedTags = new Set([...manual, ...(character && requestedOutfit !== 'default' ? outfit?.tokens ?? [] : [])])
  const merged = mergeInterrogatedTags({ tags: reference.tags, manualTags: protectedTags, protectedManualTags: protectedTags,
    identityTokens: character ? standaloneIdentityTokens(identity.identityTokens) : identity.identityTokens,
    sceneTokens: [], shot: null, replaceOutfit: Boolean(character) })
  const rejected = new Set([...merged.conflicts.map(item => item.tag), ...merged.filtered])
  const referenceOutfit = character && requestedOutfit === 'default' ? reference.tags.filter(tag => {
    const key = normalizeKey(tag)
    return !rejected.has(key) && (isGarmentToken(key) || mutualGroupWithCategory(key)?.category === 'outfit')
  }).map(normalizeKey) : []
  for (const tag of merged.accepted) if (!referenceOutfit.includes(tag)) draft.manualTags.add(tag)
  if (referenceOutfit.length) draft.outfitOverride = { tokens: referenceOutfit, replaced: outfit?.name ?? null }
  if (!merged.accepted.length && !referenceOutfit.length) throw new Error('参考图没有可安全采用的服装、姿势或背景词条，请重新提供图片或描述')
  report?.(`已反推参考图并采用 ${merged.accepted.length + referenceOutfit.filter(tag => !merged.accepted.includes(tag)).length} 个画面词条，人物身份跟随 ${character?.displayName || (char === 'nene' ? '宁宁' : '夏目')}`)
  return draft
}
