import type { Ref } from 'vue'
import { COLOR_MOODS, COMPOSITION, EMOTION, LIGHTING, SHOT } from '@/config/promptConstants'
import type { useAnimaSession } from '@/composables/generation/useAnimaSession'
import type { usePromptBuilderStore, Scene } from '@/stores/promptBuilderStore'
import { isSDParamKey, parsePromptBuilderDraft, type SDParams } from '@/utils/promptBuilderPersistence'
import { defaultOutfit, findBlueprint, findCharacter, findOutfit, type SceneBlueprint } from '@/utils/popularContent'
import type { DrawEngine } from '@/storage/settingsRepository'

type PromptBuilderStore = ReturnType<typeof usePromptBuilderStore>
type AnimaSession = ReturnType<typeof useAnimaSession>

interface BlueprintContext {
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
  if (raw.schema !== undefined && raw.schema !== SCHEMA) {
    return { applied: false, message: '蓝图版本不受支持', warnings: [] }
  }
  const draft = parsePromptBuilderDraft({ ...raw, updatedAt: raw.updatedAt ?? raw.exportedAt ?? Date.now() })
  if (!draft) return { applied: false, message: '蓝图缺少可恢复的角色、场景或描述', warnings: [] }

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
    if (draft.char) pb.setChar(draft.char)
    const scene = draft.sceneId ? pb.scenes.find(item => item.id === draft.sceneId) : null
    if (scene) ctx.selectScene(scene)
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
  pb.setArtistStyleIds(draft.artistStyleIds || [])
  if (draft.projectId !== undefined) pb.projectId = draft.projectId

  const outfitOverride = isRecord(raw.outfitOverride) ? stringList(raw.outfitOverride.tokens, 64) : []
  if (subject === 'popular' && outfitOverride.length) {
    pb.setOutfitOverride(outfitOverride, text((raw.outfitOverride as Record<string, unknown>).replaced) || null)
  } else {
    pb.clearOutfitOverride()
  }

  const sdParams = safeSDParams(draft.sdParams)
  Object.assign(pb.sdParams, sdParams)
  const touched = draft.sdParamsTouched?.length ? draft.sdParamsTouched : Object.keys(sdParams)
  touched.filter(isSDParamKey).forEach(pb.markParamTouched)

  let engine: DrawEngine = raw.drawEngine === 'anima' || raw.drawEngine === 'krea2' || raw.drawEngine === 'sd'
    ? raw.drawEngine
    : 'sd'
  if (subject === 'popular' && engine === 'sd') {
    engine = 'anima'
    warnings.push('热门角色不支持 SD，已恢复到 Anima')
  }
  if (draft.char === 'triad' && engine !== 'sd') {
    engine = 'sd'
    warnings.push('双角色配置不支持当前 Comfy 引擎，已恢复到 SD')
  }
  ctx.setDrawEngine(engine)

  const size = validSize(raw.size)
  if (engine === 'sd') {
    if (size) ctx.sdSize.value = size
  } else {
    const anima = isRecord(raw.anima) ? raw.anima : {}
    const requestedModel = text(anima.modelId)
    if (requestedModel) ctx.patchAnimaState({ modelId: requestedModel })
    await ctx.refreshAnimaBackend()
    if (requestedModel && ctx.animaState.value.modelId !== requestedModel) {
      warnings.push(`原底模 ${requestedModel} 当前不可用，已回落到可用底模`)
    }
    const patch: Parameters<AnimaSession['patchState']>[0] = {}
    const loraId = text(anima.loraId)
    const styleLoraId = text(anima.styleLoraId)
    if (subject === 'popular') patch.loraId = ''
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
    if (teaCacheThresh !== undefined) patch.teaCacheThresh = teaCacheThresh
    ctx.patchAnimaState(patch)
    const animaSize = size || validSize(`${anima.width ?? ''}x${anima.height ?? ''}`)
    if (animaSize) ctx.applyRecommendedSize(animaSize)
  }

  return { applied: true, message: '蓝图配置已完整载入', warnings }
}
