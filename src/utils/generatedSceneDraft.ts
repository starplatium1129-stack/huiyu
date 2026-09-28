import type { SceneDraft, SceneRating } from '@/types/api'
import type { BlueprintCompositionIntent, SceneBlueprint } from '@/types/sceneBlueprint'
import type { GeneratedRecipe } from '@/types/generatedRecipe'
import type { HistorySnapshot } from '@/types/promptHistory'

export interface GeneratedSceneSource {
  recipe: HistorySnapshot
  scene?: SceneDraft
  blueprint?: SceneBlueprint
}
export interface GeneratedSceneDetails {
  id: string
  title: string
  story: string
  rating: SceneRating
  category?: string
  compositionIntent?: BlueprintCompositionIntent
}

const textKeys = ['character', 'characterId', 'outfitId', 'blueprintId', 'subject', 'scene', 'sceneTitle',
  'story', 'visualDescription', 'shot', 'lighting', 'composition', 'colorMood', 'lora', 'loraId',
  'checkpoint', 'model', 'profile', 'provider', 'sampler', 'scheduler', 'size', 'styleLoraId', 'hiresUpscaler'] as const
const numberKeys = ['seed', 'steps', 'cfg', 'loraStrength', 'width', 'height', 'hiresScale', 'hiresSteps', 'hiresDenoise'] as const
const booleanKeys = ['noLora', 'hiresFix', 'faceDetailer'] as const
const listKeys = ['emotion', 'manual_tags', 'artistStyleIds'] as const
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

function parameters(value: Record<string, unknown>): HistorySnapshot {
  const output: Record<string, unknown> = {}
  for (const key of textKeys) if (typeof value[key] === 'string' || value[key] === null) output[key] = value[key]
  for (const key of numberKeys) {
    const raw = value[key]
    if (typeof raw === 'number' && Number.isFinite(raw)) output[key] = raw
    else if ((key === 'steps' || key === 'cfg') && typeof raw === 'string' && raw.trim() && Number.isFinite(Number(raw))) output[key] = raw
  }
  for (const key of booleanKeys) if (typeof value[key] === 'boolean') output[key] = value[key]
  for (const key of listKeys) if (Array.isArray(value[key]) && value[key].every(item => typeof item === 'string')) output[key] = [...value[key]]
  if (Array.isArray(value.loras) && value.loras.every(item => record(item) && typeof item.id === 'string'
    && typeof item.strength === 'number' && Number.isFinite(item.strength))) {
    output.loras = value.loras.map(item => ({ id: item.id, strength: item.strength }))
  }
  return output as HistorySnapshot
}

/** Reject malformed saved provenance and discard unrelated fields at the data boundary. */
export function parseGeneratedRecipe(value: unknown): GeneratedRecipe {
  if (!record(value) || value.version !== 1 || !['sd', 'anima', 'krea2'].includes(String(value.engine))
    || typeof value.prompt !== 'string' || !value.prompt.trim() || typeof value.negative !== 'string'
    || !record(value.parameters) || (value.engine === 'krea2' && value.negative !== '')) {
    throw new Error('生成配方不完整，请重新生成后保存场景')
  }
  return { version: 1, engine: value.engine as GeneratedRecipe['engine'], prompt: value.prompt,
    negative: value.negative, parameters: parameters(value.parameters) }
}

export function buildGeneratedSceneDraft(source: GeneratedSceneSource, details: GeneratedSceneDetails):
  { kind: 'scene'; draft: SceneDraft } | { kind: 'blueprint'; draft: SceneBlueprint } {
  if (!details.id.trim() || !details.title.trim() || !details.story.trim()
    || !['All', 'R15', 'R18'].includes(details.rating)) throw new Error('请填写名称、画面说明和分级')
  const input = source.recipe
  const recipe = parseGeneratedRecipe({ version: 1, engine: input.engine, prompt: input.prompt,
    negative: input.negative, parameters: input })
  const category = details.category?.trim() || '我的场景'
  const size = typeof input.size === 'string' ? input.size.replace('×', 'x') : ''
  const recommendedSize = /^\d{3,4}x\d{3,4}$/.test(size) ? size : ''
  if (!recommendedSize || recommendedSize.split('x').some(part => Number(part) < 512 || Number(part) > 4096 || Number(part) % 8 !== 0)) {
    throw new Error('生成结果缺少有效画幅记录，请重新生成后保存')
  }
  if (input.subject === 'popular') {
    if (!input.characterId || !input.outfitId) throw new Error('生成结果缺少角色或服装记录，请重新生成后保存')
    const base = source.blueprint
    const draft: SceneBlueprint = {
      id: details.id, title: details.title.trim(), category, description: details.story.trim(),
      characterId: input.characterId, outfitId: input.outfitId,
      location: base?.location || '', action: base?.action || '', timeOfDay: base?.timeOfDay || '',
      lighting: input.lighting || '', camera: input.shot || '', mood: (input.emotion || []).join(', '),
      sceneTags: [...(base?.sceneTags || [])],
      // A rendered request is not a tag inventory. Keep it intact; never split weighted commas.
      promptTokens: recipe.engine === 'krea2' ? [] : [recipe.prompt],
      promptProse: recipe.engine === 'krea2' ? recipe.prompt : '',
      negativeTokens: recipe.negative ? [recipe.negative] : [],
      recommendedSize: recommendedSize || base?.recommendedSize || '832x1216',
      adult: details.rating === 'R18', sampleRating: details.rating,
      compositionIntent: details.compositionIntent || base?.compositionIntent || 'single',
      generatedRecipe: recipe,
    }
    return { kind: 'blueprint', draft }
  }
  if (input.subject !== undefined && input.subject !== 'studio') throw new Error('生成结果的角色类型无效')
  const char = input.characterId || input.character
  if (char !== 'nene' && char !== 'natsume' && char !== 'triad') throw new Error('生成结果缺少工作室角色记录')
  const base = source.scene
  const draft: SceneDraft = {
    id: details.id, title: details.title.trim(), category, char,
    character: char === 'triad' ? ['nene', 'natsume'] : [char],
    lora: input.lora || input.loraId || '', emotion: (input.emotion || []).join(', '),
    season: typeof base?.season === 'string' ? base.season : '', time: '', timeOfDay: 'all_day',
    rating: details.rating, mature: details.rating === 'R18',
    location: base?.location || '', weather: base?.weather || '', camera: input.shot || '', lighting: input.lighting || '',
    tags: [...(base?.tags || [])], usage: [], story: details.story.trim(), storyJa: '',
    prompt: recipe.prompt, negative: recipe.negative, generatedRecipe: recipe,
    ...(recommendedSize ? { recommendedSize: recommendedSize.replace('x', '×') } : {}),
  }
  return { kind: 'scene', draft }
}
