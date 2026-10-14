import type { AnimaGenerationState } from '@/types/anima'
import { profileLocalStorage } from '@/platform/web/profileStorage'

// Registered model-draft prefix: shared by every desktop window and stored by the profile runtime.
const KEY = 'aics-model-draft-image-settings-v1'
const fields = ['modelId', 'loraId', 'loraStrength', 'styleLoraId', 'width', 'height', 'steps', 'cfg', 'sampler', 'scheduler',
  'seed', 'hiresFix', 'hiresScale', 'hiresDenoise', 'hiresUpscaler', 'teaCache', 'teaCacheThresh'] as const
export type DrawingSettings = Pick<AnimaGenerationState, typeof fields[number]>

function readAll(): Partial<Record<'anima' | 'krea2', DrawingSettings>> {
  try {
    const value: unknown = JSON.parse(profileLocalStorage.getItem(KEY) || '{}')
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Partial<Record<'anima' | 'krea2', DrawingSettings>> : {}
  } catch { return {} }
}

/** Local persisted input is validated again before it can become a generation recipe. */
export function readDrawingSettings(family: 'anima' | 'krea2'): DrawingSettings | null {
  const value = readAll()[family]
  if (!value || typeof value.modelId !== 'string' || !value.modelId || typeof value.loraStrength !== 'number'
    || typeof value.styleLoraId !== 'string' || typeof value.sampler !== 'string' || typeof value.scheduler !== 'string'
    || ![value.width, value.height, value.steps, value.cfg].every(item => Number.isFinite(item) && item > 0)
    || !Number.isFinite(value.loraStrength) || value.loraStrength < 0
    || (value.loraId !== undefined && typeof value.loraId !== 'string')
    || ![value.width, value.height, value.steps].every(Number.isInteger)
    || !(value.seed === null || Number.isSafeInteger(value.seed) && value.seed >= 0)
    || (value.hiresFix !== undefined && typeof value.hiresFix !== 'boolean')
    || (value.teaCache !== undefined && typeof value.teaCache !== 'boolean')
    || [value.hiresScale, value.hiresDenoise, value.teaCacheThresh].some(item => item !== undefined && !Number.isFinite(item))
    || (value.hiresUpscaler !== undefined && !['Auto', 'Latent', 'Remacri'].includes(value.hiresUpscaler))) return null
  return Object.fromEntries(fields.filter(key => value[key] !== undefined).map(key => [key, value[key]])) as DrawingSettings
}

export function saveDrawingSettings(state: AnimaGenerationState): void {
  if (!state.models.some(model => model.id === state.modelId && model.available !== false)) return
  const next = Object.fromEntries(fields.filter(key => state[key] !== undefined).map(key => [key, state[key]])) as DrawingSettings
  const all = readAll()
  if (JSON.stringify(all[state.family]) === JSON.stringify(next)) return
  profileLocalStorage.setItem(KEY, JSON.stringify({ ...all, [state.family]: next }))
}
