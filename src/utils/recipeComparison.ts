import type { ArtworkRecord } from '@/types/artwork'
import { kreaStyleSnapshot, readKreaStyles, describeKreaStyles } from './kreaStyleSelection'
import { KREA_STYLE_RECIPES, findStyleRecipe } from '@/config/kreaStyleRecipes'
import type { KreaStyleLoraSelection } from '@/types/generation'

type ScalarFields = Partial<Record<'engine' | 'model' | 'seed' | 'size' | 'steps' | 'cfg' | 'sampler' | 'scheduler' | 'lora' | 'styleLoraId' | 'kreaStyleRecipeId' | 'hiresFix' | 'hiresScale' | 'hiresDenoise' | 'faceDetailer' | 'prompt' | 'negative', string | number | boolean | null>>
export type RecipeSnapshot = ScalarFields & { styleLoraStrength?: number; styleLoras?: readonly KreaStyleLoraSelection[] }
export interface RecipeRestoreReport { title: string; notes: string[]; original?: RecipeSnapshot }
const fields: Array<[keyof ScalarFields, string]> = [
  ['engine', '引擎'], ['model', '底模'], ['seed', '种子'], ['size', '画幅'], ['steps', '步数'], ['cfg', 'CFG'],
  ['sampler', '采样器'], ['scheduler', '调度器'], ['lora', '角色 LoRA'], ['styleLoraId', '风格 LoRA'], ['kreaStyleRecipeId', '画风配方'],
  ['hiresFix', '高清修复'], ['hiresScale', '放大倍数'], ['hiresDenoise', '重绘幅度'], ['faceDetailer', '脸部修复'],
  ['prompt', '正向提示词'], ['negative', '负向提示词'],
]
/** Keep generation facts only; image data, current defaults and editable records never enter the report. */
export function snapshotHistoricalRecipe(record: ArtworkRecord): RecipeSnapshot {
  const snapshot: RecipeSnapshot = {}
  for (const [key] of fields) {
    const value = record[key]
    if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) || value === null) snapshot[key] = value
  }
  if ('styleLoras' in record || 'styleLoraId' in record) Object.assign(snapshot, kreaStyleSnapshot(record))
  if (!snapshot.model && typeof record.checkpoint === 'string') snapshot.model = record.checkpoint
  if (typeof snapshot.size === 'string') snapshot.size = snapshot.size.replace('×', 'x')
  if (record.engine !== 'sd' && typeof record.loraId === 'string' && record.loraId) {
    snapshot.lora = `${record.loraId}${typeof record.loraStrength === 'number' ? `:${record.loraStrength}` : ''}`
  }
  if (record.engine === 'sd' && Array.isArray(record.loras)) {
    const loras = record.loras.filter((item): item is { id: string; strength: number } => Boolean(item) && typeof item === 'object'
      && typeof (item as Record<string, unknown>).id === 'string' && typeof (item as Record<string, unknown>).strength === 'number'
      && Number.isFinite((item as Record<string, unknown>).strength))
    if (loras.length === record.loras.length) snapshot.lora = loras.length ? loras.map(item => `${item.id}:${item.strength}`).join(', ') : null
  }
  return snapshot
}
function valueText(key: keyof ScalarFields, source: RecipeSnapshot | null, historical: boolean): string {
  const value = source?.[key]
  if (value === undefined) return historical ? '未记录' : '未就绪'
  if (key === 'kreaStyleRecipeId') return findStyleRecipe(KREA_STYLE_RECIPES, String(value))?.name ?? (value || '跟随场景').toString()
  if (value === null || value === '') return key === 'negative' ? '空' : '无'
  if (typeof value === 'boolean') return value ? '开启' : '关闭'
  if (key === 'seed' && Number(value) < 0) return '随机'
  if (key === 'styleLoraId') return describeKreaStyles(readKreaStyles(source)) || '无'
  return String(value)
}
export function compareRecipes(original: RecipeSnapshot, current: RecipeSnapshot | null) {
  return fields.map(([key, label]) => {
    const before = original[key], after = current?.[key]
    const numeric = ['seed', 'steps', 'cfg', 'hiresScale', 'hiresDenoise'].includes(key)
    const equal = key === 'styleLoraId'
      ? JSON.stringify(readKreaStyles(original)) === JSON.stringify(readKreaStyles(current))
      : before === after || numeric && before != null && after != null && before !== '' && after !== '' && Number(before) === Number(after)
    const status: 'missing' | 'unavailable' | 'same' | 'changed' = before === undefined ? 'missing' : after === undefined ? 'unavailable' : equal ? 'same' : 'changed'
    return { key, label, before: valueText(key, original, true), after: valueText(key, current, false), status }
  })
}
