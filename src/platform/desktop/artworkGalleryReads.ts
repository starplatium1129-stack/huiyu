import type { GalleryCatalog, GalleryCursor, GalleryPage, GalleryQuery } from '../../application/artwork/galleryQuery.ts'
import { artworkTimestamp, type ArtworkRecord } from '../../types/artwork.ts'
import { parseArtworkRecentIndex, parseArtworkRow } from './artworkReadModel.ts'
import { getDesktopRuntime } from './runtime.ts'

type Request = <T>(command: Record<string, unknown>, signal?: AbortSignal) => Promise<T>
/** Browsing owns summaries; recipe/original consumers still read full records. */
export function createDesktopGalleryReads(request: Request, session: () => string,
  historyCache: () => ArtworkRecord[] | null, mutationVersion: () => number) {
  let recent: { session: string; version: number; history: ArtworkRecord[] } | undefined
  function record(raw: unknown): ArtworkRecord {
    const id = (raw as { id?: unknown })?.id
    if (typeof id !== 'string' && typeof id !== 'number') throw new Error('作品摘要无效')
    const row = parseArtworkRow(raw, id)
    if (!row || row.deletedAt !== null) throw new Error('作品摘要无效')
    return { ...row.body, _galleryRevision: row.revision }
  }
  async function read<T>(command: Record<string, unknown>, signal: AbortSignal): Promise<T> {
    const identity = session(), value = await request<T>(command, signal)
    signal.throwIfAborted()
    if (session() !== identity) throw new Error('作品库连接已变化，请重新读取')
    return value
  }
  function version(value: { revision: number; projectsVersion: string }) {
    if (!Number.isSafeInteger(value.revision) || value.revision < 0 || typeof value.projectsVersion !== 'string') throw new Error('作品库修订号无效')
  }
  async function readGalleryPage(query: GalleryQuery, cursor: GalleryCursor | null, signal: AbortSignal, limit = 24): Promise<GalleryPage> {
    const page = await read<Omit<GalleryPage, 'items'> & { items: unknown[] }>({ kind: 'readGalleryPage', query: structuredClone(query), cursor, limit }, signal)
    version(page)
    if (!Array.isArray(page.items) || page.items.length > limit || !Number.isSafeInteger(page.total) || page.total < 0) throw new Error('作品分页无效')
    const next = page.nextCursor
    if (next !== null && (!next || typeof next.key !== 'string' || !Number.isFinite(next.time) || next.revision !== page.revision
      || next.projects !== page.projectsVersion || typeof next.query !== 'string' || cursor && next.query !== cursor.query || cursor && !(next.time < cursor.time || next.time === cursor.time && next.key > cursor.key))) throw new Error('作品翻页游标无效')
    if (cursor && (cursor.revision !== page.revision || cursor.projects !== page.projectsVersion)) throw new Error('作品库在翻页期间发生变更，请重新读取')
    const items = page.items.map(record)
    if (new Set(items.map(item => String(item.id).trim())).size !== items.length) throw new Error('作品分页含重复记录')
    return { ...page, items }
  }
  async function readGalleryCatalog(signal: AbortSignal): Promise<GalleryCatalog> {
    const catalog = await read<Omit<GalleryCatalog, 'covers'> & { covers: unknown[] }>({ kind: 'readGalleryCatalog' }, signal)
    version(catalog)
    const buckets = [catalog.tags, ...Object.values(catalog.generation)]
    if (![catalog.total, catalog.favoriteCount].every(n => Number.isSafeInteger(n) && n >= 0)
      || buckets.some(items => !Array.isArray(items) || items.some(item => typeof item.value !== 'string' || !Number.isSafeInteger(item.count) || item.count < 0))
      || [catalog.albums, catalog.characters].some(items => !Array.isArray(items) || items.some(item => typeof item.id !== 'string'
        || !Number.isSafeInteger(item.count) || item.count < 0 || !Array.isArray(item.coverIds) || item.coverIds.length > 3
        || item.coverIds.some(id => typeof id !== 'string' && typeof id !== 'number')))) throw new Error('作品目录统计无效')
    return { ...catalog, covers: catalog.covers.map(record) }
  }
  async function readRecentHistory(signal?: AbortSignal, limit = 3) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('最近作品数量无效')
    signal?.throwIfAborted()
    const identity = session(), version = mutationVersion()
    const offline = recent?.session === identity && recent.version === version ? recent.history : historyCache()
    if (getDesktopRuntime().connection !== 'ready' && offline) return structuredClone(offline.slice(0, limit))
    const result = await request<unknown>({ kind: 'readArtworkRecentIndex', candidateLimit: limit }, signal)
    signal?.throwIfAborted()
    const selected = parseArtworkRecentIndex(result).sort((a, b) => artworkTimestamp(b) - artworkTimestamp(a)).slice(0, limit)
    const rows = selected.length ? await request<unknown>({ kind: 'getArtworks', ids: selected.map(row => row.id) }, signal) : []
    signal?.throwIfAborted()
    if (!Array.isArray(rows) || rows.length !== selected.length) throw new Error('最近作品响应无效')
    const parsed = rows.map((row, index) => parseArtworkRow(row, selected[index].id))
    if (parsed.some((row, index) => !row || row.deletedAt !== null || row.revision !== selected[index].revision)) throw new Error('作品库在读取期间发生变更，请重新读取')
    if (session() !== identity) throw new Error('作品库连接已变化，请重新读取')
    const history = structuredClone(parsed.map(row => row!.body))
    if (version === mutationVersion()) recent = { session: identity, version, history }
    return structuredClone(history)
  }
  async function getPreview(id: string, width: number, signal?: AbortSignal) {
    const identity = session()
    const preview = await request<string | null>({ kind: 'readThumbnail', alias: id, width }, signal)
    signal?.throwIfAborted()
    if (session() !== identity) throw new Error('作品库连接已变化，请重新读取')
    return preview
  }
  return { readGalleryPage, readGalleryCatalog, readRecentHistory, getPreview }
}
