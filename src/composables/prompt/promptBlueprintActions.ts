import type { Ref } from 'vue'
import type { PromptDraftState } from './usePromptDraft'
import { hasEditedSceneStyle } from '@/utils/randomVariationContext'
import { sceneLighting, sceneShot, sceneColorMood, sceneComposition, sceneRecommendedSize } from '@/utils/sceneInference'
import { normalizeArtistStyleIds } from '@/config/artistStyles'
import { COLOR_MOODS, COMPOSITION, EMOTION, LIGHTING, SHOT } from '@/config/promptConstants'
import { endfieldAnimaBinding } from '@/utils/loraCatalog'
import type { useAnimaSession } from '@/composables/generation/useAnimaSession'
import type { usePromptBuilderStore, Scene } from '@/stores/promptBuilderStore'
import { cloneReferenceInput, isSDParamKey, type DraftOutfitOverride, type DraftReferenceInput, type DraftRandomVariation, type PromptBuilderDraft, type SDParams } from '@/utils/promptBuilderPersistence'
import { defaultOutfit, findBlueprint, findCharacter, findOutfit, type SceneBlueprint } from '@/utils/popularContent'
import type { DrawEngine } from '@/storage/settingsRepository'

type PromptBuilderStore = ReturnType<typeof usePromptBuilderStore>
type AnimaSession = ReturnType<typeof useAnimaSession>

interface BlueprintContext {
  isCurrent?: () => boolean
  getDrawEngine?: () => DrawEngine
  getAnimaSettingsRevision?: () => number
  pb: PromptBuilderStore
  selectScene: (scene: Scene) => void
  selectPopularSource: (source: 'studio' | 'popular') => void
  selectBlueprint: (blueprint: SceneBlueprint) => void
  setDirectorMode: (mode: 'basic' | 'pro') => void
  setDrawEngine: (engine: DrawEngine) => void
  applyRecommendedSize: (size: string) => void
  refreshAnimaBackend: AnimaSession['refreshBackend']
  animaState: AnimaSession['state']
  patchAnimaState: AnimaSession['patchState']
  sdSize: Ref<string>
}

export interface BlueprintLoadResult {
  applied: boolean
  message: string
  warnings: string[]
}

const SCHEMA = 'aics-director-blueprint-v1'
const ids = <T extends { id: string }>(items: readonly T[]) => new Set(items.map(item => item.id))
const EMOTION_IDS = ids(EMOTION)
const SHOT_IDS = ids(SHOT)
const LIGHTING_IDS = ids(LIGHTING)
const COMPOSITION_IDS = ids(COMPOSITION)
const COLOR_MOOD_IDS = ids(COLOR_MOODS)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown, max = 256): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function stringList(value: unknown, limit = 512): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.flatMap(item => {
    const value = text(item, 160)
    return value ? [value] : []
  }))].slice(0, limit)
}

function finite(value: unknown, min: number, max: number): number | undefined {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : undefined
}

function safeSDParams(value: Partial<SDParams> | undefined): Partial<SDParams> {
  if (!value) return {}
  const result: Partial<SDParams> = { ...value }
  if (value.cfg !== undefined) result.cfg = finite(value.cfg, 1, 20)
  if (value.steps !== undefined) result.steps = finite(value.steps, 1, 150)
  if (value.hiresScale !== undefined) result.hiresScale = finite(value.hiresScale, 1, 4)
  if (value.hiresSteps !== undefined) result.hiresSteps = finite(value.hiresSteps, 1, 150)
  if (value.hiresDenoise !== undefined) result.hiresDenoise = finite(value.hiresDenoise, 0, 1)
  if (value.seed !== undefined) result.seed = Math.round(finite(value.seed, -1, 2_147_483_647) ?? -1)
  for (const key of ['sampler', 'scheduler', 'size', 'hiresUpscaler'] as const) {
    if (value[key] !== undefined) result[key] = text(value[key])
  }
  if (value.negativeCustom !== undefined) result.negativeCustom = text(value.negativeCustom, 12_000)
  return result
}

function validSize(value: unknown): string {
  const normalized = text(value, 32).replace('×', 'x')
  return /^\d{3,4}x\d{3,4}$/.test(normalized) ? normalized : ''
}

function selection(value: unknown, allowed: ReadonlySet<string>): string | null {
  if (value === null) return null
  return typeof value === 'string' && allowed.has(value) ? value : null
}

/** Versioned, allowlisted blueprint import. Legacy v1 objects without schema remain readable. */
export async function loadBlueprint(raw: Record<string, unknown>, ctx: BlueprintContext): Promise<BlueprintLoadResult> {
  const { pb } = ctx
  const interrupted = (): BlueprintLoadResult => ({ applied: false, message: '载入已中断，已应用部分保留；当前草稿未继续覆盖', warnings: [] })
  if (ctx.isCurrent && !ctx.isCurrent()) return interrupted()
  if (raw.schema !== undefined && raw.schema !== SCHEMA) {
    return { applied: false, message: '蓝图版本不受支持', warnings: [] }
  }
  const draft = parsePromptBuilderDraft({ ...raw, updatedAt: raw.updatedAt ?? raw.exportedAt ?? Date.now() })
  if (!draft) return { applied: false, message: '蓝图缺少可恢复的角色、场景或描述', warnings: [] }
  if(draft.char==='triad')return {applied:false,message:'旧双角色配置依赖已退役的 SD 路径，原蓝图保留；请重新选择角色',warnings:[]}
  const retiredSD=raw.drawEngine==='sd'

  const warnings: string[] = []
  const subject = draft.subject === 'popular' ? 'popular' : 'studio'
  if (subject === 'popular') {
    const character = findCharacter(pb.popularCharacters, draft.characterId || '')
    const outfit = character
      ? (findOutfit(character, draft.outfitId || '') ?? (!draft.outfitId ? defaultOutfit(character) : null))
      : null
    const blueprint = draft.blueprintId ? findBlueprint(pb.sceneBlueprints, draft.blueprintId) : null
    if (!character || !outfit) return { applied: false, message: '蓝图引用的热门角色或服装已不可用', warnings }
    if (draft.blueprintId && (!blueprint || (blueprint.characterId && blueprint.characterId !== character.id))) {
      return { applied: false, message: '蓝图引用的角色场景已不可用或归属不一致', warnings }
    }
    ctx.selectPopularSource('popular')
    pb.setPopularSubject(character.id, outfit.id, blueprint?.id ?? null)
    if (blueprint) ctx.selectBlueprint(blueprint)
  } else {
    if (pb.isPopular) ctx.selectPopularSource('studio')
    if (draft.char === 'none') pb.setUnboundSubject()
    else if (draft.char) pb.setChar(draft.char)
    const scene = draft.sceneId ? pb.scenes.find(item => item.id === draft.sceneId) : null
    if (scene && !pb.isUnbound) ctx.selectScene(scene)
    else {
      pb.clearScene({ keepStory: true })
      if (draft.sceneId) warnings.push(`原场景 ${draft.sceneId} 当前不可用，已保留其余自定义内容`)
    }
  }

  if (draft.directorMode) ctx.setDirectorMode(draft.directorMode)
  if (draft.story !== undefined) pb.story = draft.story
  if (draft.visualDescription !== undefined) pb.visualDescription = draft.visualDescription
  if (draft.selections) {
    const validEmotions = draft.selections.emotion?.filter(id => EMOTION_IDS.has(id)) ?? []
    if (validEmotions.length !== (draft.selections.emotion?.length ?? 0)) warnings.push('部分未知情绪选项已跳过')
    pb.selections.emotion = validEmotions
    pb.setShot(selection(draft.selections.shot, SHOT_IDS))
    pb.setLighting(selection(draft.selections.lighting, LIGHTING_IDS))
    pb.setComposition(selection(draft.selections.composition, COMPOSITION_IDS))
  }
  pb.setColorMood(selection(draft.colorMood, COLOR_MOOD_IDS))
  pb.manualTags = new Set(stringList(draft.manualTags))
  pb.referenceInput = cloneReferenceInput(draft.referenceInput)
  pb.setArtistStyleIds(draft.artistStyleIds || [])
  if (draft.projectId !== undefined) pb.projectId = draft.projectId

  const outfitOverride = isRecord(raw.outfitOverride) ? stringList(raw.outfitOverride.tokens, 64) : []
  if (subject === 'popular' && outfitOverride.length) {
    pb.setOutfitOverride(outfitOverride, text((raw.outfitOverride as Record<string, unknown>).replaced) || null)
  } else {
    pb.clearOutfitOverride()
  }

  if(!retiredSD){
    const sdParams = safeSDParams(draft.sdParams)
    Object.assign(pb.sdParams, sdParams)
    const touched = draft.sdParamsTouched?.length ? draft.sdParamsTouched : Object.keys(sdParams)
    touched.filter(isSDParamKey).forEach(pb.markParamTouched)
  }

  const engine: DrawEngine = raw.drawEngine === 'krea2' ? 'krea2' : 'anima'
  if(retiredSD)warnings.push('已沿用文本与构图，SD 生成参数未跨引擎迁移；请核对当前 Anima 条件')
  ctx.setDrawEngine(engine)

  const size = validSize(raw.size)
  if(!retiredSD) {
    const anima = isRecord(raw.anima) ? raw.anima : {}
    const requestedModel = text(anima.modelId)
    if (requestedModel) ctx.patchAnimaState({ modelId: requestedModel })
    const draftFingerprint = () => {
      const { updatedAt: _updatedAt, ...draft } = pb.snapshotDraft()
      return JSON.stringify(draft)
    }
    const before = draftFingerprint(), sizeBefore = ctx.sdSize.value
    const settingsBefore = ctx.getAnimaSettingsRevision?.()
    const refreshed = await ctx.refreshAnimaBackend()
    if (!refreshed || ctx.isCurrent && !ctx.isCurrent() || before !== draftFingerprint()
      || ctx.getDrawEngine && ctx.getDrawEngine() !== engine
      || settingsBefore !== ctx.getAnimaSettingsRevision?.() || sizeBefore !== ctx.sdSize.value) return interrupted()
    if (requestedModel && ctx.animaState.value.modelId !== requestedModel) {
      warnings.push(`原底模 ${requestedModel} 当前不可用，已回落到可用底模`)
    }
    const patch: Parameters<AnimaSession['patchState']>[0] = {}
    const loraId = text(anima.loraId)
    const styleLoraId = text(anima.styleLoraId)
    if (pb.isUnbound) patch.loraId = ''
    else if (subject === 'popular') patch.loraId = endfieldAnimaBinding(ctx.pb.subject.kind === 'popular' ? ctx.pb.subject.characterId : null,
      engine, ctx.animaState.value.modelId)?.loraId ?? ''
    else if (loraId && ctx.animaState.value.loras.some(item => item.id === loraId)) patch.loraId = loraId
    else if (loraId) warnings.push(`原 LoRA ${loraId} 当前不可用，未恢复`)
    if (styleLoraId && ctx.animaState.value.styleLoras.some(item => item.id === styleLoraId)) patch.styleLoraId = styleLoraId
    else if (styleLoraId) warnings.push(`原风格 LoRA ${styleLoraId} 当前不可用，未恢复`)
    const loraStrength = finite(anima.loraStrength, 0, 2)
    const steps = finite(anima.steps, 1, 150)
    const cfg = finite(anima.cfg, 0, 20)
    const seed = anima.seed === null ? null : finite(anima.seed, 0, 2_147_483_647)
    const hiresScale = finite(anima.hiresScale, 1, 4)
    const hiresDenoise = finite(anima.hiresDenoise, 0, 1)
    const teaCacheThresh = finite(anima.teaCacheThresh, 0, 1)
    if (loraStrength !== undefined) patch.loraStrength = loraStrength
    if (steps !== undefined) patch.steps = Math.round(steps)
    if (cfg !== undefined) patch.cfg = cfg
    if (seed !== undefined) patch.seed = seed === null ? null : Math.round(seed)
    if (typeof anima.sampler === 'string') patch.sampler = text(anima.sampler)
    if (typeof anima.scheduler === 'string') patch.scheduler = text(anima.scheduler)
    if (typeof anima.hiresFix === 'boolean') patch.hiresFix = anima.hiresFix
    if (hiresScale !== undefined) patch.hiresScale = hiresScale
    if (hiresDenoise !== undefined) patch.hiresDenoise = hiresDenoise
    if (typeof anima.teaCache === 'boolean') patch.teaCache = anima.teaCache
    else if (ctx.animaState.value.provider === 'native' && anima.teaCache === undefined) patch.teaCache = undefined
    if (teaCacheThresh !== undefined) patch.teaCacheThresh = teaCacheThresh
    else if (ctx.animaState.value.provider === 'native' && anima.teaCacheThresh === undefined) patch.teaCacheThresh = undefined
    ctx.patchAnimaState(patch)
    const animaSize = size || validSize(`${anima.width ?? ''}x${anima.height ?? ''}`)
    if (animaSize) ctx.applyRecommendedSize(animaSize)
  }

  return { applied: true, message: '蓝图配置已完整载入', warnings }
}

// Draft compatibility keeps its original permissive string/list rules. Blueprint
// imports above use a stricter boundary and must not normalize old draft fields.
function draftRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
function draftText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
function draftNullableText(value: unknown): string | null | undefined {
  return value === null ? null : draftText(value)
}

function draftNumber(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : undefined
}

function draftStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function parseOutfitOverride(value: unknown): DraftOutfitOverride | null {
  if (!draftRecord(value)) return null
  const tokens = [...new Set(draftStrings(value.tokens).map(token => token.trim()).filter(Boolean))]
  return tokens.length ? { tokens, replaced: draftNullableText(value.replaced) ?? null } : null
}

function parseReferenceInput(value: unknown): DraftReferenceInput | null {
  if (!draftRecord(value)) return null
  const tags = [...new Set(draftStrings(value.tags).map(tag => tag.trim()).filter(Boolean))]
  return cloneReferenceInput({ tags, characterTokens: draftStrings(value.characterTokens), copyrightTokens: draftStrings(value.copyrightTokens) })
}

function parseRandomVariation(value: unknown): DraftRandomVariation | null {
  if (!draftRecord(value) || typeof value.prompt !== 'string' || typeof value.prose !== 'string' || typeof value.source !== 'string' || typeof value.context !== 'string') return null
  return { context: value.context, source: value.source, prompt: value.prompt, prose: value.prose, tags: draftStrings(value.tags), outfit: draftStrings(value.outfit) }
}

function parseSDParams(value: unknown): Partial<SDParams> {
  if (!draftRecord(value)) return {}
  const result: Partial<SDParams> = {}
  const cfg = draftNumber(value.cfg)
  const steps = draftNumber(value.steps)
  const hiresScale = draftNumber(value.hiresScale)
  const hiresSteps = draftNumber(value.hiresSteps)
  const hiresDenoise = draftNumber(value.hiresDenoise)
  const seed = draftNumber(value.seed)
  if (cfg !== undefined) result.cfg = cfg
  if (steps !== undefined) result.steps = steps
  if (hiresScale !== undefined) result.hiresScale = hiresScale
  if (hiresSteps !== undefined) result.hiresSteps = hiresSteps
  if (hiresDenoise !== undefined) result.hiresDenoise = hiresDenoise
  if (seed !== undefined) result.seed = seed
  for (const key of ['sampler', 'scheduler', 'size', 'hiresUpscaler', 'negativeCustom'] as const) {
    const text = draftText(value[key])
    if (text !== undefined) result[key] = text
  }
  for (const key of ['hiresFix', 'faceDetailer', 'seedLock', 'quality', 'tail', 'negative'] as const) {
    if (typeof value[key] === 'boolean') result[key] = value[key]
  }
  return result
}

function parsePromptBuilderDraft(value: unknown): PromptBuilderDraft | null {
  if (!draftRecord(value)) return null
  const updatedAt = draftNumber(value.updatedAt)
  const story = draftText(value.story)
  const visualDescription = draftText(value.visualDescription) || ''
  const sceneId = draftNullableText(value.sceneId)
  // 参数和模式也属于草稿；尚未填写画面内容的工作区仍须能恢复。
  if (!updatedAt) return null

  const rawSelections = draftRecord(value.selections) ? value.selections : null
  const selections = rawSelections
    ? {
        emotion: draftStrings(rawSelections.emotion),
        shot: draftNullableText(rawSelections.shot) ?? null,
        lighting: draftNullableText(rawSelections.lighting) ?? null,
        composition: draftNullableText(rawSelections.composition) ?? null,
      }
    : undefined
  const char = value.char === 'nene' || value.char === 'natsume' || value.char === 'triad' || value.char === 'none'
    ? value.char
    : undefined
  const directorMode = value.directorMode === 'basic' || value.directorMode === 'pro'
    ? value.directorMode
    : undefined

  return {
    updatedAt,
    randomVariation: parseRandomVariation(value.randomVariation),
    sceneStyleBaseline: draftRecord(value.sceneStyleBaseline) ? {
      shot: draftNullableText(value.sceneStyleBaseline.shot) ?? null,
      lighting: draftNullableText(value.sceneStyleBaseline.lighting) ?? null,
      composition: draftNullableText(value.sceneStyleBaseline.composition) ?? null,
      colorMood: draftNullableText(value.sceneStyleBaseline.colorMood) ?? null,
    } : undefined,
    story,
    visualDescription,
    char,
    sceneId,
    sceneTitle: draftNullableText(value.sceneTitle),
    selections,
    colorMood: draftNullableText(value.colorMood),
    manualTags: draftStrings(value.manualTags),
    outfitOverride: value.subject === 'popular' ? parseOutfitOverride(value.outfitOverride) : null,
    referenceInput: parseReferenceInput(value.referenceInput),
    artistStyleIds: normalizeArtistStyleIds(value.artistStyleIds),
    sceneBaseStory: draftText(value.sceneBaseStory),
    directorMode,
    sdParams: parseSDParams(value.sdParams),
    // 只保留已知参数键，避免脏键污染 touched 集合。
    sdParamsTouched: draftStrings(value.sdParamsTouched).filter(key => isSDParamKey(key)),
    projectId: draftText(value.projectId),
    subject: value.subject === 'popular' ? 'popular' : 'studio',
    characterId: draftText(value.characterId),
    outfitId: draftText(value.outfitId),
    blueprintId: draftNullableText(value.blueprintId),
    noLora: typeof value.noLora === 'boolean' ? value.noLora : undefined,
  }
}

/** Called synchronously only after the mounted owner checks the original pointer. */
export function restorePromptDraft(state: PromptDraftState, raw: string): boolean {
  const draft = parsePromptBuilderDraft(JSON.parse(raw))
  if (!draft) return false
  const { subject, story, visualDescription, char, sceneId, selections, colorMood, manualTags,
    outfitOverride, referenceInput, randomVariation, artistStyleIds, sceneBaseStory, directorMode,
    sdParams, sdParamsTouched, projectId, scenes, lastRecommendedSize } = state
  function applyDraft(d: PromptBuilderDraft) {
    // Context watchers must not retire the previous overlay against restored tags.
    // The saved overlay is adopted last, after all subject/outfit changes.
    randomVariation.value = null
    if (typeof d.story === 'string') story.value = d.story
    if (typeof d.visualDescription === 'string') visualDescription.value = d.visualDescription
    if (d.char) char.value = d.char
    if (d.sceneId !== undefined) {
      sceneId.value = d.sceneId
      const currentScene = scenes.value.find(s => s.id === d.sceneId)
      if (currentScene) {
        lastRecommendedSize.value = sceneRecommendedSize(currentScene)
        // 场景未被用户魔改时，镜头与推荐配置自动跟随最新场景定义更新，避免旧草稿锁死过时机位
        const isUnmodifiedScene = (!d.story || d.story === currentScene.story) && (d.sceneBaseStory === currentScene.story || !d.sceneBaseStory)
        if (isUnmodifiedScene && !hasEditedSceneStyle(d)) {
          sceneBaseStory.value = currentScene.story ?? ''
          story.value = currentScene.story ?? story.value
          selections.shot = sceneShot(currentScene)
          selections.lighting = sceneLighting(currentScene)
          selections.composition = sceneComposition(currentScene)
          colorMood.value = sceneColorMood(currentScene)
          applySharedDraft(d)
          return
        }
      }
    }
    if (d.sceneBaseStory !== undefined) sceneBaseStory.value = d.sceneBaseStory
    if (d.selections) {
      selections.emotion = d.selections.emotion ?? []
      selections.shot = d.selections.shot ?? null
      selections.lighting = d.selections.lighting ?? null
      selections.composition = d.selections.composition ?? null
    }
    if (typeof d.colorMood === 'string' || d.colorMood === null) colorMood.value = d.colorMood
    applySharedDraft(d)
  }

  function applySharedDraft(d: PromptBuilderDraft) {
    if (d.manualTags) manualTags.value = new Set(d.manualTags)
    referenceInput.value = cloneReferenceInput(d.referenceInput)
    artistStyleIds.value = normalizeArtistStyleIds(d.artistStyleIds)
    if (d.directorMode) directorMode.value = d.directorMode
    if (d.sdParams) Object.assign(sdParams, d.sdParams)
    // 2026-08-16 审计：恢复草稿时同步重建 touched 集合——否则恢复的用户参数会被
    // 后续 applyModelProfile（切底模/引擎等）当默认值静默覆盖。缺省（旧草稿）
    // 保持原行为：不标记任何键。
    sdParamsTouched.value = new Set((d.sdParamsTouched ?? []).filter(isSDParamKey))
    if (typeof d.projectId === 'string') projectId.value = d.projectId
    if (d.subject === 'popular' && d.characterId && d.outfitId) {
      subject.value = { kind: 'popular', characterId: d.characterId, outfitId: d.outfitId, blueprintId: d.blueprintId ?? null }
    } else {
      subject.value = { kind: 'studio' }
    }
    outfitOverride.value = subject.value.kind === 'popular' && d.outfitOverride
      ? { tokens: [...d.outfitOverride.tokens], replaced: d.outfitOverride.replaced }
      : null
    randomVariation.value = d.randomVariation ? JSON.parse(JSON.stringify(d.randomVariation)) : null
  }

  applyDraft(draft)
  return true
}
