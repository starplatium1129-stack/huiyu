import type { ArtworkRecord } from '@/types/artwork'

/** Read-only projection for recipe restoration. Never fills or rewrites the stored record. */
export function parseHistoryRecipe(record: ArtworkRecord) {
  const notes: string[] = []
  const text = (key: string) => {
    const value = record[key]
    if (value === undefined || value === null) return undefined
    if (typeof value === 'string') return value
    notes.push(`${key} 格式无效，未恢复`)
    return undefined
  }
  const number = (key: string) => {
    const value = record[key]
    if (value === undefined || value === null || value === '') return undefined
    const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
    if (Number.isFinite(parsed)) return parsed
    notes.push(`${key} 格式无效，未恢复`)
    return undefined
  }
  const boolean = (key: string) => {
    const value = record[key]
    if (value === undefined || value === null) return undefined
    if (typeof value === 'boolean') return value
    notes.push(`${key} 格式无效，未恢复`)
    return undefined
  }
  const strings = (key: string): string[] | undefined => {
    const value = record[key]
    if (value === undefined || value === null) return undefined
    if (Array.isArray(value) && value.every(item => typeof item === 'string')) return [...value]
    notes.push(`${key} 格式无效，未恢复`)
    return undefined
  }
  const engine = record.engine
  if (engine !== undefined && engine !== 'sd' && engine !== 'anima' && engine !== 'krea2') {
    return { ok: false as const, error: `未知引擎 ${String(engine)}，当前草稿已保留` }
  }
  if (record.seed === undefined || record.seed === null) notes.push('未记录种子，无法精确复现')
  if (!record.prompt) notes.push('未记录完整提示词，无法精确复现')
  const recipe = {
    id: record.id, engine,
    subject: text('subject'), character: text('character'), characterId: text('characterId'),
    outfitId: text('outfitId'), blueprintId: text('blueprintId'), noLora: boolean('noLora'),
    model: text('model'), checkpoint: text('checkpoint'), styleLoraId: text('styleLoraId'),
    loraId: text('loraId'), loraStrength: number('loraStrength'),
    size: text('size'), seed: number('seed'), steps: number('steps'), cfg: number('cfg'),
    sampler: text('sampler'), scheduler: text('scheduler'), negative: text('negative'),
    hiresFix: boolean('hiresFix'), hiresScale: number('hiresScale'), hiresDenoise: number('hiresDenoise'),
    hiresUpscaler: text('hiresUpscaler'), hiresSteps: number('hiresSteps'), faceDetailer: boolean('faceDetailer'),
    scene: text('scene'), sceneTitle: text('sceneTitle'), story: text('story'), visualDescription: text('visualDescription'),
    emotion: strings('emotion'), manual_tags: strings('manual_tags'), artistStyleIds: strings('artistStyleIds'),
    shot: text('shot'), lighting: text('lighting'), composition: text('composition'), colorMood: text('colorMood'), project: text('project'),
  }
  return { ok: true as const, recipe, notes }
}
