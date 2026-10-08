import { parseArtworkRecords, type ArtworkRecord } from '../../types/artwork.ts'
import { parseArtworkSearchSummaries } from '../../application/artwork/searchIndex.ts'

const key = (id: string | number) => String(id).trim()
const revision = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/** SQLite BINARY compares UTF-8/scalar order, not JavaScript UTF-16 or locale order. */
export function compareArtworkKeys(a: string | number, b: string | number): number {
  const left = Array.from(key(a)), right = Array.from(key(b))
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const difference = left[i].codePointAt(0)! - right[i].codePointAt(0)!
    if (difference) return difference
  }
  return left.length - right.length
}

export function parseArtworkSearchPage(raw: unknown) {
  if (!raw || typeof raw !== 'object') throw new Error('作品搜索响应无效')
  const page = raw as { items: unknown; artworkRevision: unknown; nextCursor: unknown }
  if (!revision(page.artworkRevision) || !(page.nextCursor === null || typeof page.nextCursor === 'string' && page.nextCursor.trim())) {
    throw new Error('作品搜索响应无效')
  }
  return { items: parseArtworkSearchSummaries(page.items), revision: page.artworkRevision, nextCursor: page.nextCursor as string | null }
}

export interface ArtworkRow { id: string | number; body: ArtworkRecord; revision: number; deletedAt: number | null }
export interface ArtworkRecentEntry { id: string | number; timestamp: unknown; revision: number }

export function parseArtworkRow(raw: unknown, expectedId: string | number): ArtworkRow | null {
  if (!parseArtworkRecords([{ id: expectedId }]).length) throw new Error('作品编号无效')
  if (raw === null) return null
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('作品响应无效')
  const row = raw as ArtworkRow
  if (!parseArtworkRecords([row]).length || key(row.id) !== key(expectedId) || !revision(row.revision)
    || !(row.deletedAt === null || typeof row.deletedAt === 'number' && Number.isFinite(row.deletedAt))
    || !parseArtworkRecords([row.body]).length || key(row.body.id) !== key(row.id)) throw new Error('作品响应无效')
  return row
}

/** Validate the complete atomic projection before publishing or selecting any rows. */
export function parseArtworkRecentIndex(raw: unknown): ArtworkRecentEntry[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('最近作品索引无效')
  const result = raw as { items: unknown; revision: unknown }
  if (!Array.isArray(result.items) || !revision(result.revision)) throw new Error('最近作品索引无效')
  const ids = new Set<string>()
  const parsed: ArtworkRecentEntry[] = []
  for (const rawItem of result.items as unknown[]) {
    const item = parseArtworkRecords([rawItem])[0]
    if (!item || !revision(item.revision) || item.revision > result.revision || ids.has(key(item.id))) {
      throw new Error('最近作品索引无效')
    }
    ids.add(key(item.id))
    parsed.push({ id: item.id, timestamp: item.timestamp, revision: item.revision })
  }
  return parsed
}
