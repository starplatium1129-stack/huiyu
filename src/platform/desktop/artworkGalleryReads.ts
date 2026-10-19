import type { ArtworkLibrarySnapshot, ArtworkProjectRecord } from '../../application/artwork/artworkRepository.ts'
import { artworkTimestamp, type ArtworkRecord } from '../../types/artwork.ts'
import { parseArtworkRecentIndex, parseArtworkRow } from './artworkReadModel.ts'
import { getDesktopRuntime } from './runtime.ts'

type Request = <T>(command: Record<string, unknown>, signal?: AbortSignal) => Promise<T>
/** Browsing owns summaries; recipe/original consumers still read full records. */
export function createDesktopGalleryReads(request: Request, readProjects: () => Promise<ArtworkProjectRecord[]>, session: () => string,
  historyCache: () => ArtworkRecord[] | null, mutationVersion: () => number) {
  let cached: { session: string; revision: number; snapshot: ArtworkLibrarySnapshot } | undefined
  let recent: { session: string; version: number; history: ArtworkRecord[] } | undefined
  async function readGallerySnapshot(publish: (snapshot: ArtworkLibrarySnapshot) => void, signal: AbortSignal): Promise<ArtworkLibrarySnapshot> {
    const identity = session()
    const current = () => { signal.throwIfAborted(); if (session() !== identity) throw new Error('作品库连接已变化，请重新读取') }
    if (cached?.session === identity) {
      const status = await request<{ artworkRevision: number }>({ kind: 'status' }, signal)
      current()
      if (status.artworkRevision === cached.revision) {
        const projects = await readProjects(); current()
        return { history: structuredClone(cached.snapshot.history), projects }
      }
    }
    const [first, projects] = await Promise.all([
      request<unknown>({ kind: 'readArtworkRecentIndex', candidateLimit: 24 }, signal), readProjects(),
    ])
    current()
    const selected = parseArtworkRecentIndex(first).sort((a, b) => artworkTimestamp(b) - artworkTimestamp(a)).slice(0, 24)
    const initial = selected.length ? await request<unknown[]>({ kind: 'getArtworks', ids: selected.map(item => item.id), projection: 'gallery' }, signal) : []
    current()
    if (!Array.isArray(initial) || initial.length !== selected.length) throw new Error('作品首批响应无效')
    const history = initial.map((raw, index) => {
      const row = parseArtworkRow(raw, selected[index].id)
      if (!row || row.deletedAt !== null || row.revision !== selected[index].revision) throw new Error('作品库在读取期间发生变更，请重新读取')
      return { ...row.body, _galleryRevision: row.revision }
    })
    current()
    publish(structuredClone({ history, projects }))
    // Let Vue mount and paint the first page before collecting further pages.
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    const all: ArtworkRecord[] = []
    const ids = new Set<string>()
    let cursor: string | null = null, revision: number | undefined
    do {
      current()
      const page: { items: unknown[]; nextCursor: string | null; artworkRevision: number } = await request({
        kind: 'listArtworks', projection: 'gallery', limit: 200, ...(cursor ? { cursor } : {}),
      }, signal)
      current()
      if (!Array.isArray(page.items) || !Number.isSafeInteger(page.artworkRevision) || page.artworkRevision < 0
        || revision !== undefined && revision !== page.artworkRevision
        || !(page.nextCursor === null || typeof page.nextCursor === 'string' && page.nextCursor > (cursor || ''))) throw new Error('作品库在读取期间发生变更，请重新读取')
      revision = page.artworkRevision
      for (const raw of page.items) {
        const id = (raw as { id?: unknown })?.id
        if (typeof id !== 'string' && typeof id !== 'number') throw new Error('作品摘要无效')
        const row = parseArtworkRow(raw, id), key = String(id).trim()
        if (!row || row.deletedAt !== null || ids.has(key)) throw new Error('作品摘要无效')
        ids.add(key); all.push({ ...row.body, _galleryRevision: row.revision })
      }
      cursor = page.nextCursor
      if (cursor) await new Promise<void>(resolve => setTimeout(resolve, 0))
    } while (cursor)
    current()
    const snapshot = { history: all.sort((a, b) => artworkTimestamp(b) - artworkTimestamp(a)), projects }
    cached = { session: identity, revision: revision!, snapshot: structuredClone(snapshot) }
    return snapshot
  }
  async function readRecentHistory(signal?: AbortSignal) {
    signal?.throwIfAborted()
    const identity = session(), version = mutationVersion()
    const offline = recent?.session === identity && recent.version === version ? recent.history : historyCache()
    if (getDesktopRuntime().connection !== 'ready' && offline) return structuredClone(offline.slice(0, 3))
    const result = await request<unknown>({ kind: 'readArtworkRecentIndex', candidateLimit: 3 }, signal)
    signal?.throwIfAborted()
    const selected = parseArtworkRecentIndex(result).sort((a, b) => artworkTimestamp(b) - artworkTimestamp(a)).slice(0, 3)
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
  return { readGallerySnapshot, readRecentHistory, getPreview }
}
