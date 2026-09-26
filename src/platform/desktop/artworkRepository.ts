import type { ArtworkRepository, ArtworkProjectRecord } from '../../application/artwork/artworkRepository.ts'
import { artworkTimestamp, parseArtworkRecords, type ArtworkRecord } from '../../types/artwork.ts'
import { blobThumbDataUrl } from '../../utils/imageThumb.ts'
import { workspaceRequest as request } from '../../api/workspace.ts'
import { desktopRuntimeFetch, getDesktopRuntime } from './runtime.ts'

interface Row { id: string | number; body: ArtworkRecord; revision: number; deletedAt: number | null }
interface Page { items: Row[]; nextCursor: string | null; revision: number }
interface Receipt { artwork?: Row; changed?: boolean; removed?: number; purged?: number }
export function createDesktopArtworkRepository(): ArtworkRepository {
  let workspaceId = getDesktopRuntime().bootstrap?.runtime?.workspace?.workspaceId
  function requireAuthority() {
    const session = getDesktopRuntime().bootstrap?.runtime?.workspace
    if (!session?.domains.includes('artwork') || (workspaceId && workspaceId !== session.workspaceId)) throw new Error('作品库身份尚未确认，请重新连接')
    workspaceId ??= session.workspaceId
  }
  const workspaceRequest = <T>(command: Record<string, unknown>): Promise<T> => { requireAuthority(); return request<T>(command) }
  const thumbnails = new Map<string, string>()
  let loadedHistory: ArtworkRecord[] = [], loadedProjects: ArtworkProjectRecord[] = []
  let historyLoaded = false, projectsLoaded = false
  async function list(includeDeleted = false): Promise<Row[]> {
    const rows: Row[] = []
    let cursor: string | null = null
    let revision: number | undefined
    do {
      const page: Page = await workspaceRequest({ kind: 'listArtworks', limit: 200, includeDeleted, ...(cursor ? { cursor } : {}) })
      if (revision !== undefined && revision !== page.revision) throw new Error('作品库在读取期间发生变更，请重新读取')
      revision = page.revision; rows.push(...page.items); cursor = page.nextCursor
    } while (cursor)
    return rows
  }
  async function readHistory() {
    if (getDesktopRuntime().connection !== 'ready' && historyLoaded) return structuredClone(loadedHistory)
    loadedHistory = parseArtworkRecords((await list()).map(row => row.body)).sort((a, b) => artworkTimestamp(b) - artworkTimestamp(a))
    historyLoaded = true
    return structuredClone(loadedHistory)
  }
  async function readProjects() {
    if (getDesktopRuntime().connection !== 'ready' && projectsLoaded) return structuredClone(loadedProjects)
    const result = await workspaceRequest<{ items: Array<{ body: ArtworkProjectRecord }> }>({ kind: 'listProjects' })
    loadedProjects = result.items.map(item => item.body); projectsLoaded = true
    return structuredClone(loadedProjects)
  }
  const row = (id: string | number) => workspaceRequest<Row | null>({ kind: 'getArtwork', id })
  async function mutate(kind: string, id: string | number, extra: Record<string, unknown> = {}): Promise<Receipt | null> {
    const current = await row(id)
    if (!current) return null
    const result = await workspaceRequest<Receipt>({ kind, id, operationId: crypto.randomUUID(), expectedRevision: current.revision, ...extra })
    historyLoaded = false; projectsLoaded = false
    return result
  }
  async function getImage(id: string): Promise<Blob | null> {
    requireAuthority()
    const response = await desktopRuntimeFetch('/api/workspace/media-capabilities', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ alias: id }) })
    if (response.status === 404) return null
    if (!response.ok) throw new Error('作品原图暂时不可用')
    const capability = await response.json() as { url: string }
    const media = await desktopRuntimeFetch(capability.url)
    if (!media.ok) throw new Error('作品原图读取未完成')
    return media.blob()
  }
  return {
    readHistory, readProjects, readRecentHistory: readHistory, readPreferenceHistory: readHistory,
    async readLibrarySnapshot() { const [history, projects] = await Promise.all([readHistory(), readProjects()]); return { history, projects } },
    getImage,
    async putImage(blob) {
      const bytes = new Uint8Array(await blob.arrayBuffer())
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('')
      const alias = `image-${crypto.randomUUID()}`, operationId = crypto.randomUUID()
      const state = await workspaceRequest<{ media: { writtenBytes: number } }>({ kind: 'prepareMedia', operationId, media: { alias, sha256: hash, bytes: bytes.length, mime: blob.type } })
      for (let offset = state.media.writtenBytes; offset < bytes.length; offset += 1024 * 1024) await workspaceRequest({ kind: 'uploadMediaChunk', operationId, offset, data: bytes.subarray(offset, offset + 1024 * 1024) })
      await workspaceRequest({ kind: 'commitMedia', operationId })
      return alias
    },
    async deleteImage(alias) { await workspaceRequest({ kind: 'releaseMedia', alias, operationId: crypto.randomUUID() }) },
    countImages: () => workspaceRequest<number>({ kind: 'countMedia' }),
    async getThumbnail(id) {
      if (thumbnails.has(id)) return thumbnails.get(id)!
      const blob = await getImage(id)
      if (!blob || !blob.type.startsWith('image/')) return null
      const thumb = await blobThumbDataUrl(blob)
      if (thumb) thumbnails.set(id, thumb)
      return thumb || null
    },
    async setThumbnail(id, value) { thumbnails.set(id, value) },
    async cacheThumbnail(id, blob) { const value = await blobThumbDataUrl(blob); if (value) thumbnails.set(id, value) },
    withStaging: work => work(),
    async appendArtwork(artwork) {
      // Entity identity is the retry key. Lost acknowledgements can safely re-read
      // the same record without generating another artwork or releasing its media.
      await workspaceRequest({ kind: 'appendArtwork', operationId: `artwork:${String(artwork.id)}`, artwork })
      return readHistory()
    },
    async patchArtwork(id, patch) { return { updated: Boolean((await mutate('patchArtwork', id, { patch }))?.changed) } },
    async patchArtworks(patches) { for (const item of patches) await mutate('patchArtwork', item.id, { patch: item.patch }) },
    async deleteArtwork(id) {
      const current = await row(id), result = current ? await mutate('hardDeleteArtwork', id) : null
      return { deleted: Boolean(result?.changed), historyChanged: Boolean(result?.changed), removedImageIds: [], removedThumbnailIds: [], removedProjectReferences: result?.removed ?? 0 }
    },
    async softDeleteArtwork(id) { return { deleted: Boolean((await mutate('softDeleteArtwork', id))?.changed) } },
    async restoreArtwork(id) { return { restored: Boolean((await mutate('restoreArtwork', id))?.changed) } },
    async purgeExpiredTrash() { const result = await workspaceRequest<Receipt>({ kind: 'purgeExpiredTrash', operationId: crypto.randomUUID() }); return { purged: result.purged ?? 0 } },
    async listTrash() { return (await list(true)).filter(item => item.deletedAt !== null).map(item => ({ id: String(item.id), deletedAt: item.deletedAt!, historyEntries: [item.body], projectRefs: [], imageIds: item.body.image_id ? [item.body.image_id] : [] })) },
  }
}
