import type { TaskRecord } from '../../types/tasks'
import type { HistoryEntry } from '@/types/promptHistory'
import type { AnimaJobMetadata, AnimaResultContext } from '@/types/anima'

const metadataKeys = [
  'prompt', 'negative', 'profileId', 'modelId', 'loraId', 'loraStrength', 'loras', 'styleLoraId',
  'width', 'height', 'steps', 'cfg', 'sampler', 'scheduler', 'seed', 'character', 'preview',
  'hiresFix', 'hiresScale', 'hiresDenoise', 'hiresUpscaler', 'hiresSteps', 'faceDetailer',
  'teaCache', 'teaCacheThresh', 'initImage', 'maskImage', 'maskPrompt', 'denoisingStrength', 'growMaskBy',
] as const
const recipeKeys = ['engine', 'provider', 'profile', 'model', 'checkpoint', 'prompt', 'negative', 'seed', 'cfg', 'steps', 'sampler', 'scheduler', 'size',
  'lora', 'loraId', 'loraStrength', 'loras', 'styleLoraId', 'preview', 'hiresFix', 'hiresScale', 'hiresUpscaler', 'hiresSteps', 'hiresDenoise', 'faceDetailer']

/** Runtime effective input and provider observations are facts; form values are not. */
export function runtimeImageMetadata(task: TaskRecord): AnimaJobMetadata {
  const source = { ...task.input, ...task.metadata }
  const metadata: Record<string, unknown> = {}
  for (const key of metadataKeys) if (source[key] !== undefined) metadata[key] = structuredClone(source[key])
  return { ...metadata, engine: task.kind === 'creative' ? 'krea2' : 'anima',
    id: task.taskId, createdAt: task.createdAt, resultUrl: `/api/tasks/v1/${encodeURIComponent(task.taskId)}/results/0`,
  } as unknown as AnimaJobMetadata
}

/** Convert only recorded generation fields, never gateway-only keys or credentials. */
export function runtimeTaskRecipe(task: TaskRecord): Partial<HistoryEntry> {
  const source = { ...task.input, ...task.metadata }
  const recipe: Record<string, unknown> = { engine: task.kind === 'generation' ? 'sd' : task.kind === 'creative' ? 'krea2' : task.kind }
  const text = { prompt: 'prompt', negative: 'negative', profileId: 'profile', modelId: 'model', sampler: 'sampler', scheduler: 'scheduler', hiresUpscaler: 'hiresUpscaler' }
  for (const [from, to] of Object.entries(text)) if (typeof source[from] === 'string') recipe[to] = source[from]
  if (recipe.profile === '') delete recipe.profile
  if (recipe.model !== undefined) recipe.checkpoint = recipe.model
  for (const key of ['cfg', 'steps', 'hiresScale', 'hiresSteps']) {
    if (typeof source[key] === 'number' && Number.isFinite(source[key])) recipe[key] = source[key]
  }
  if (typeof source.seed === 'number' && Number.isSafeInteger(source.seed) && source.seed >= 0) recipe.seed = source.seed
  for (const key of ['hiresFix', 'faceDetailer', 'preview']) if (typeof source[key] === 'boolean') recipe[key] = source[key]
  const denoise = source.hiresDenoise ?? source.denoisingStrength
  if (typeof denoise === 'number' && Number.isFinite(denoise)) recipe.hiresDenoise = denoise
  if (typeof source.width === 'number' && source.width > 0 && typeof source.height === 'number' && source.height > 0) recipe.size = `${source.width}x${source.height}`
  if (task.provider === 'webui' || task.provider === 'comfy') recipe.provider = task.provider
  for (const key of ['loraId', 'styleLoraId']) if (source[key] === null || typeof source[key] === 'string') recipe[key] = source[key]
  if (source.loraStrength === null || typeof source.loraStrength === 'number' && Number.isFinite(source.loraStrength)) recipe.loraStrength = source.loraStrength
  if (Array.isArray(source.loras) && source.loras.every(lora => lora && typeof lora.id === 'string' && typeof lora.strength === 'number' && Number.isFinite(lora.strength))) {
    const loras = source.loras.map(lora => ({ id: lora.id, strength: lora.strength }))
    recipe.loras = loras
    recipe.lora = loras.map(lora => `${lora.id}:${lora.strength}`).join(', ') || null
    recipe.loraId = loras[0]?.id ?? null; recipe.loraStrength = loras[0]?.strength ?? null
  } else if ('loraId' in recipe) recipe.lora = recipe.loraId
  return recipe as Partial<HistoryEntry>
}

/** A detached presentation/archive snapshot; runtime remains the task authority. */
export function runtimeTaskResultContext(task: TaskRecord): AnimaResultContext {
  const context = task.metadata.context
  const frozen = context && typeof context === 'object' && !Array.isArray(context)
    ? structuredClone(context) as AnimaResultContext : {}
  const history = { ...frozen.history } as Record<string, unknown>
  for (const key of recipeKeys) delete history[key]
  return { ...frozen, history: { ...history, ...runtimeTaskRecipe(task) } }
}
