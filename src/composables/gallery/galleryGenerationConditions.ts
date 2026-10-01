import type { ArtworkRecord } from '@/types/artwork'

export const GENERATION_FILTER_FIELDS = ['engine', 'model', 'outfit', 'seed', 'size', 'reviewState'] as const
export type GenerationFilterField = typeof GENERATION_FILTER_FIELDS[number]
export type GalleryGenerationConditions = Record<GenerationFilterField, string>
export interface GalleryFilterSnapshot {
  favoriteOnly: boolean
  projectFilter: string
  characterFilter: string
  searchQuery: string
  tagFilter: string
  generation: GalleryGenerationConditions
}
export const UNRECORDED_CONDITION = 'missing'
export const recordedCondition = (value: string): string => `v:${value}`
export const conditionText = (value: string): string => value.startsWith('v:') ? value.slice(2) : ''
export function emptyGenerationConditions(): GalleryGenerationConditions {
  return { engine: '', model: '', outfit: '', seed: '', size: '', reviewState: '' }
}
export function normalizeGenerationConditions(raw: unknown): GalleryGenerationConditions {
  const input = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  return Object.fromEntries(GENERATION_FILTER_FIELDS.map(field => {
    const value = input[field]
    return [field, typeof value === 'string' && (value === UNRECORDED_CONDITION || (value.startsWith('v:') && value.length > 2 && value.length <= 2048)) ? value : '']
  })) as GalleryGenerationConditions
}
export function normalizeGalleryFilterSnapshot(raw: unknown): GalleryFilterSnapshot {
  const input = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const text = (key: string) => typeof input[key] === 'string' ? input[key] as string : ''
  return { favoriteOnly: input.favoriteOnly === true, projectFilter: text('projectFilter'), characterFilter: text('characterFilter'), searchQuery: text('searchQuery'), tagFilter: text('tagFilter'), generation: normalizeGenerationConditions(input.generation) }
}

const savedText = (value: unknown): string => typeof value === 'string' ? value.trim() : ''
export function recordedSeed(value: unknown): string {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? String(value) : ''
  if (typeof value !== 'string' || !/^-?\d+$/.test(value.trim())) return ''
  return BigInt(value.trim()).toString()
}
function savedSize(item: ArtworkRecord): string {
  const size = savedText(item.size)
  const match = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(size)
  if (match && Number(match[1]) > 0 && Number(match[2]) > 0) return `${Number(match[1])}x${Number(match[2])}`
  // width/height are measured output pixels (including hires), not generation parameters.
  return size
}
export type RecordedGenerationConditions = Record<GenerationFilterField, string[]>
/** Read only saved fields. Engine, seed and review state have no inferred defaults. */
export function artworkGenerationConditions(item: ArtworkRecord): RecordedGenerationConditions {
  const role = savedText(item.characterId) || savedText(item.character)
  const outfit = savedText(item.outfitId)
  const one = (value: string) => value ? [value] : []
  return {
    engine: one(savedText(item.engine)),
    model: [...new Set([savedText(item.checkpoint), savedText(item.model)].filter(Boolean))],
    outfit: one(role && outfit ? JSON.stringify([role, outfit]) : ''),
    seed: one(recordedSeed(item.seed)), size: one(savedSize(item)),
    reviewState: one(['candidate', 'preferred', 'rejected'].includes(String(item.reviewState)) ? String(item.reviewState) : ''),
  }
}
export function matchesGenerationConditions(record: RecordedGenerationConditions, filters: GalleryGenerationConditions): boolean {
  return GENERATION_FILTER_FIELDS.every(field => {
    const selected = filters[field]
    if (!selected) return true
    return selected === UNRECORDED_CONDITION ? record[field].length === 0 : record[field].includes(conditionText(selected))
  })
}
export function generationConditionLabel(field: GenerationFilterField, selected: string): string {
  if (selected === UNRECORDED_CONDITION) return '未记录'
  const value = conditionText(selected)
  if (field === 'engine') return ({ sd: 'SD WebUI', anima: 'Anima', krea2: 'Krea 2' } as Record<string, string>)[value] || value
  if (field === 'reviewState') return ({ candidate: '候选', preferred: '已选定', rejected: '未选中' } as Record<string, string>)[value] || value
  if (field === 'outfit') {
    try {
      const pair = JSON.parse(value)
      if (Array.isArray(pair) && pair.length === 2 && pair.every(item => typeof item === 'string')) return `${pair[0]} · ${pair[1]}`
    } catch { /* An unknown URL selection remains visible with zero matches. */ }
  }
  return value
}
export function generationConditionOptions(records: Iterable<RecordedGenerationConditions>, filters: GalleryGenerationConditions) {
  const counts = Object.fromEntries(GENERATION_FILTER_FIELDS.map(field => [field, new Map<string, number>([[UNRECORDED_CONDITION, 0]])])) as Record<GenerationFilterField, Map<string, number>>
  for (const record of records) for (const field of GENERATION_FILTER_FIELDS) {
    for (const value of record[field].length ? record[field].map(recordedCondition) : [UNRECORDED_CONDITION]) {
      counts[field].set(value, (counts[field].get(value) || 0) + 1)
    }
  }
  return Object.fromEntries(GENERATION_FILTER_FIELDS.map(field => {
    const values = counts[field]
    if (filters[field] && !values.has(filters[field])) values.set(filters[field], 0)
    return [field, [...values].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([value, count]) => ({ value, label: `${generationConditionLabel(field, value)} · ${count}` }))]
  })) as Record<GenerationFilterField, { value: string; label: string }[]>
}
