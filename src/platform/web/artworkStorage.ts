import type { ImageRecordInput, StoredImageRecord } from '../../composables/useImageStore.ts'
import { ARTWORK_HISTORY_KV_KEY, ARTWORK_PROJECTS_KV_KEY, ARTWORK_TRASH_KV_KEY } from '../../utils/storageKeys.ts'
export const ARTWORK_HISTORY_KEY = ARTWORK_HISTORY_KV_KEY
export const ARTWORK_PROJECTS_KEY = ARTWORK_PROJECTS_KV_KEY
export const ARTWORK_TRASH_KEY = ARTWORK_TRASH_KV_KEY

/** 软删条目保留天数；超期由懒清理（作品册挂载时）真删图片与缩略图。 */
export const ARTWORK_TRASH_RETENTION_DAYS = 30

export interface ArtworkKvAdapter {
  get(key: string): Promise<unknown | null>
  set(key: string, value: unknown): Promise<void>
  setMany?(entries: Array<{ key: string; value: unknown }>): Promise<void>
  remove?(key: string): Promise<void>
}

export interface ArtworkImageAdapter {
  get(id: string): Promise<StoredImageRecord | null>
  put?(blob: Blob): Promise<string>
  count?(): Promise<number>
  putRecord(record: ImageRecordInput): Promise<string>
  deleteMany(ids: string[]): Promise<void>
}

export interface WebArtworkRepositoryDependencies {
  kv?: Partial<ArtworkKvAdapter>
  images?: Partial<ArtworkImageAdapter>
  localStorage?: Pick<Storage, 'getItem' | 'removeItem'>
}


export class ArtworkDeletionError extends Error {
  readonly originalError: unknown
  readonly rollbackErrors: unknown[]

  constructor(originalError: unknown, rollbackErrors: unknown[] = [], operation = '作品删除') {
    const detail = originalError instanceof Error ? originalError.message : String(originalError)
    super(rollbackErrors.length
      ? `${operation}失败，补偿回滚也失败：${detail}`
      : `${operation}失败，已补偿回滚：${detail}`)
    this.name = 'ArtworkDeletionError'
    this.originalError = originalError
    this.rollbackErrors = rollbackErrors
  }
}

export function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export function comparableId(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

export function recordId(value: unknown): string | null {
  return comparableId(record(value)?.id)
}

export function imageId(value: unknown): string | null {
  const id = record(value)?.image_id
  return typeof id === 'string' && id.trim() ? id.trim() : null
}

export function unique(values: readonly (string | null)[]): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))]
}

export function arrayValue(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value.slice() : null
}

export function removeProjectReferences(value: unknown, targetId: string): {
  value: unknown
  changed: boolean
  removed: number
} {
  const projects = arrayValue(value)
  if (!projects) return { value, changed: false, removed: 0 }
  let changed = false
  let removed = 0
  const next = projects.map(project => {
    const source = record(project)
    if (!source || !Array.isArray(source.history_ids)) return project
    const historyIds = source.history_ids
    const filtered = historyIds.filter(id => comparableId(id) !== targetId)
    if (filtered.length === historyIds.length) return project
    changed = true
    removed += historyIds.length - filtered.length
    return { ...source, history_ids: filtered }
  })
  return { value: next, changed, removed }
}

export function imageRecordInput(record: StoredImageRecord): ImageRecordInput {
  return {
    id: record.id,
    blob: record.blob,
    name: record.name,
    type: record.type,
    created_at: record.created_at,
  }
}

export async function callSafely(action: () => Promise<void>, errors: unknown[]): Promise<void> {
  try { await action() } catch (error) { errors.push(error) }
}
