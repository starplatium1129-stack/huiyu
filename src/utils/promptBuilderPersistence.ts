import type { ModelProfile } from './promptPolicy'
import { normalizeArtistStyleIds } from '../config/artistStyles.ts'

export type DraftCharKey = 'nene' | 'natsume' | 'triad'

export interface SDParams {
  cfg: number
  steps: number
  sampler: string
  scheduler: string
  size: string
  hiresFix: boolean
  hiresScale: number
  hiresUpscaler: string
  hiresSteps: number
  hiresDenoise: number
  faceDetailer: boolean
  seedLock: boolean
  seed: number
  quality: boolean
  tail: boolean
  negative: boolean
  negativeCustom: string
}

export interface DraftSelections {
  emotion: string[]
  shot: string | null
  lighting: string | null
  composition: string | null
}

export interface PromptBuilderDraft {
  updatedAt: number
  story?: string
  visualDescription?: string
  char?: DraftCharKey
  sceneId?: string | null
  sceneTitle?: string | null
  selections?: Partial<DraftSelections>
  colorMood?: string | null
  manualTags?: string[]
  artistStyleIds?: string[]
  sceneBaseStory?: string
  directorMode?: 'basic' | 'pro'
  sdParams?: Partial<SDParams>
  /** 2026-08-16 审计：用户手动确认过的出图参数键——恢复草稿时若不同步恢复
   *  touched 集合，后续 applyModelProfile 会把恢复值当默认值静默覆盖。 */
  sdParamsTouched?: string[]
  projectId?: string
  /** 热门角色无 LoRA 创作模式（旧草稿缺省为 studio，向后兼容）。 */
  subject?: 'studio' | 'popular'
  characterId?: string
  outfitId?: string
  blueprintId?: string | null
  noLora?: boolean
}

export interface ProjectOption {
  id: string
  name: string
}

export interface PromptPreset {
  id: string
  name: string
  label: string
  [key: string]: unknown
}

export interface RestoredHistoryContext<TScene extends { id: string }> {
  scene: TScene | null
  story: string
}

const SD_PARAM_KEYS = new Set<keyof SDParams>([
  'cfg', 'steps', 'sampler', 'scheduler', 'size', 'hiresFix', 'hiresScale',
  'hiresUpscaler', 'hiresSteps', 'hiresDenoise', 'faceDetailer', 'seedLock',
  'seed', 'quality', 'tail', 'negative', 'negativeCustom',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function nullableString(value: unknown): string | null | undefined {
  return value === null ? null : stringValue(value)
}

function finiteNumber(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : undefined
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

export function isSDParamKey(key: string): key is keyof SDParams {
  return SD_PARAM_KEYS.has(key as keyof SDParams)
}

export function parseSDParams(value: unknown): Partial<SDParams> {
  if (!isRecord(value)) return {}
  const result: Partial<SDParams> = {}
  const cfg = finiteNumber(value.cfg)
  const steps = finiteNumber(value.steps)
  const hiresScale = finiteNumber(value.hiresScale)
  const hiresSteps = finiteNumber(value.hiresSteps)
  const hiresDenoise = finiteNumber(value.hiresDenoise)
  const seed = finiteNumber(value.seed)
  if (cfg !== undefined) result.cfg = cfg
  if (steps !== undefined) result.steps = steps
  if (hiresScale !== undefined) result.hiresScale = hiresScale
  if (hiresSteps !== undefined) result.hiresSteps = hiresSteps
  if (hiresDenoise !== undefined) result.hiresDenoise = hiresDenoise
  if (seed !== undefined) result.seed = seed
  for (const key of ['sampler', 'scheduler', 'size', 'hiresUpscaler', 'negativeCustom'] as const) {
    const text = stringValue(value[key])
    if (text !== undefined) result[key] = text
  }
  for (const key of ['hiresFix', 'faceDetailer', 'seedLock', 'quality', 'tail', 'negative'] as const) {
    if (typeof value[key] === 'boolean') result[key] = value[key]
  }
  return result
}

export function parsePromptBuilderDraft(value: unknown): PromptBuilderDraft | null {
  if (!isRecord(value)) return null
  const updatedAt = finiteNumber(value.updatedAt)
  const story = stringValue(value.story)
  const visualDescription = stringValue(value.visualDescription) || ''
  const sceneId = nullableString(value.sceneId)
  // 画面描述/手动词条本身就是可生成输入；不能因没有故事或场景而丢弃这类草稿。
  const hasStandaloneInput = Boolean(visualDescription || stringList(value.manualTags).length)
  // 热门角色无 LoRA 草稿没有 sceneId/story（蓝图驱动场景），单独放行。
  if (!updatedAt || ((!sceneId && !story && !hasStandaloneInput) && value.subject !== 'popular')) return null

  const rawSelections = isRecord(value.selections) ? value.selections : null
  const selections = rawSelections
    ? {
        emotion: stringList(rawSelections.emotion),
        shot: nullableString(rawSelections.shot) ?? null,
        lighting: nullableString(rawSelections.lighting) ?? null,
        composition: nullableString(rawSelections.composition) ?? null,
      }
    : undefined
  const char = value.char === 'nene' || value.char === 'natsume' || value.char === 'triad'
    ? value.char
    : undefined
  const directorMode = value.directorMode === 'basic' || value.directorMode === 'pro'
    ? value.directorMode
    : undefined

  return {
    updatedAt,
    story,
    visualDescription,
    char,
    sceneId,
    sceneTitle: nullableString(value.sceneTitle),
    selections,
    colorMood: nullableString(value.colorMood),
    manualTags: stringList(value.manualTags),
    artistStyleIds: normalizeArtistStyleIds(value.artistStyleIds),
    sceneBaseStory: stringValue(value.sceneBaseStory),
    directorMode,
    sdParams: parseSDParams(value.sdParams),
    // 只保留已知参数键，避免脏键污染 touched 集合。
    sdParamsTouched: stringList(value.sdParamsTouched).filter(key => SD_PARAM_KEYS.has(key as keyof SDParams)),
    projectId: stringValue(value.projectId),
    subject: value.subject === 'popular' ? 'popular' : 'studio',
    characterId: stringValue(value.characterId),
    outfitId: stringValue(value.outfitId),
    blueprintId: nullableString(value.blueprintId),
    noLora: typeof value.noLora === 'boolean' ? value.noLora : undefined,
  }
}

/** Resolve the scene first; callers apply the returned story after loadScene(). */
export function restoreHistorySceneStory<TScene extends { id: string }>(
  entry: unknown,
  scenes: TScene[],
): RestoredHistoryContext<TScene> {
  const record = isRecord(entry) ? entry : {}
  const sceneId = stringValue(record.scene)
  const scene = sceneId ? (scenes.find(item => item.id === sceneId) ?? null) : null
  return { scene, story: stringValue(record.story) || '' }
}

export function parseProjectOptions(value: unknown): ProjectOption[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item): ProjectOption[] => {
    if (!isRecord(item)) return []
    if (typeof item.id !== 'string' && typeof item.id !== 'number') return []
    const id = String(item.id).trim()
    if (!id) return []
    const label = stringValue(item.name) || stringValue(item.title) || id
    return [{ id, name: label }]
  })
}

function parseModelProfile(value: unknown): ModelProfile | null {
  if (!isRecord(value)) return null
  const engine = value.engine === 'sd' || value.engine === 'anima' || value.engine === 'krea2' ? value.engine : undefined
  const tagStyle = value.tag_style === 'underscore' || value.tag_style === 'space' ? value.tag_style : undefined
  const negativeMode = value.negative_mode === 'merge' || value.negative_mode === 'replace'
    ? value.negative_mode
    : undefined
  const replaceScope = value.negative_replace_scope === 'boilerplate' || value.negative_replace_scope === 'all'
    ? value.negative_replace_scope
    : undefined
  return {
    ...value,
    id: stringValue(value.id),
    name: stringValue(value.name),
    engine,
    model_id: stringValue(value.model_id),
    tag_style: tagStyle,
    lora_in_prompt: typeof value.lora_in_prompt === 'boolean' ? value.lora_in_prompt : undefined,
    lora_id: stringValue(value.lora_id),
    lora_name: stringValue(value.lora_name),
    lora_strength: finiteNumber(value.lora_strength),
    exact_tokens: stringList(value.exact_tokens),
    exact_prefixes: stringList(value.exact_prefixes),
    match: stringList(value.match),
    quality_prefix: stringValue(value.quality_prefix),
    negative_prefix: stringValue(value.negative_prefix),
    negative_mode: negativeMode,
    negative_replace_scope: replaceScope,
    rating_all: stringValue(value.rating_all),
    rating_r15: stringValue(value.rating_r15),
    rating_r18: stringValue(value.rating_r18),
    sampler: stringValue(value.sampler),
    scheduler: stringValue(value.scheduler),
    steps: finiteNumber(value.steps),
    cfg: finiteNumber(value.cfg),
    size: stringValue(value.size),
    hires_fix: typeof value.hires_fix === 'boolean' ? value.hires_fix : undefined,
    hires_steps: finiteNumber(value.hires_steps),
    hires_scale: finiteNumber(value.hires_scale),
    hires_upscaler: stringValue(value.hires_upscaler),
    hires_denoising_strength: finiteNumber(value.hires_denoising_strength),
  }
}

function parsePreset(value: unknown): PromptPreset | null {
  if (!isRecord(value)) return null
  const id = stringValue(value.id)
  if (!id) return null
  const name = stringValue(value.name) || stringValue(value.label) || id
  return { ...value, id, name, label: stringValue(value.label) || name }
}

export function parsePresetCatalog(value: unknown): {
  presets: PromptPreset[]
  modelProfiles: ModelProfile[]
} {
  const presetValues = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.presets)
      ? value.presets
      : []
  const profileValues = isRecord(value) && Array.isArray(value.model_profiles)
    ? value.model_profiles
    : []
  return {
    presets: presetValues.map(parsePreset).filter((item): item is PromptPreset => item !== null),
    modelProfiles: profileValues.map(parseModelProfile).filter((item): item is ModelProfile => item !== null),
  }
}
