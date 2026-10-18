import type { PromptPreset } from './promptBuilderPersistence'
import type { ModelProfile } from './promptPolicy'

/** Read-only upgrade defaults, loaded with the catalog rather than the route. */
export async function fillMissingModelProfiles(personal: ModelProfile[]): Promise<ModelProfile[]> {
  const { default: bundledPresetCatalog } = await import('../../data/presets.json')
  const ids = new Set(personal.map(profile => profile.id))
  const models = new Set(personal.map(profile => profile.model_id))
  const bundled = parsePresetCatalog(bundledPresetCatalog).modelProfiles
  const missing = bundled.filter(profile =>
    !ids.has(profile.id) && (!profile.model_id || !models.has(profile.model_id)))
  const miaomiao = bundled.find(profile => profile.model_id === 'anima-miaomiao-v1.6')!
  return [...personal, ...missing].map(profile => {
    const copy: ModelProfile = JSON.parse(JSON.stringify(profile))
    if (copy.model_id !== miaomiao.model_id) return copy
    // Installed metadata can predate the bundled compiler. Upgrade only known shipped prompt defaults.
    if (['masterpiece, best quality, very aesthetic', 'best quality, score_7, score_9, very aesthetic, ultra detailed'].includes(copy.quality_prefix || '')) {
      copy.quality_prefix = miaomiao.quality_prefix
    }
    const authorNegative = miaomiao.negative_prefix!
    const animaNegative = 'worst quality, low quality, score_1, score_2, score_3, artist name, blurry, jpeg artifacts, chromatic aberration'
    const legacyNegative = `${authorNegative}, blurry, jpeg artifacts, chromatic aberration, border, white_border, framed, letterbox, padding, margin, inset, comic_panel`
    if ([authorNegative, animaNegative, legacyNegative].includes(copy.negative_prefix || '')) {
      copy.negative_prefix = authorNegative
      copy.negative_mode = miaomiao.negative_mode
    }
    copy.rating_mode = miaomiao.rating_mode
    delete copy.rating_all
    delete copy.rating_r15
    delete copy.rating_r18
    return copy
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function finiteNumber(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : undefined
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
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
    rating_mode: value.rating_mode === 'scene' || value.rating_mode === 'prompt' ? value.rating_mode : undefined,
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
