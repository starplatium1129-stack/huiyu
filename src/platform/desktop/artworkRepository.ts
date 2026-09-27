import { ARTWORK_DELETE_BATCH_SIZE, type ArtworkRepository, type ArtworkProjectRecord, type ArtworkSoftDeleteResult } from '../../application/artwork/artworkRepository.ts'
import { artworkTimestamp, parseArtworkRecords, type ArtworkRecord } from '../../types/artwork.ts'
import { createDesktopArtworkMedia } from './artworkMedia.ts'
import { workspaceRequest as request } from '../../api/workspace.ts'
import { getDesktopRuntime } from './runtime.ts'
import { trackMaintenanceWrite } from '../maintenanceParticipants.ts'

interface Row { id: string | number; body: ArtworkRecord; revision: number; deletedAt: number | null }
interface Page { items: Row[]; nextCursor: string | null; revision: number }
interface Receipt { artwork?: Row; changed?: boolean; removed?: number; purged?: number; softDeleteResults?: ArtworkSoftDeleteResult[] }
export function createDesktopArtworkRepository(): ArtworkRepository {
  let workspaceId = getDesktopRuntime().bootstrap?.runtime?.workspace?.workspaceId
  function requireAuthority() {
    const session = getDesktopRuntime().bootstrap?.runtime?.workspace
    if (!session?.domains.includes('artwork') || (workspaceId && workspaceId !== session.workspaceId)) throw new Error('作品库身份尚未确认，请重新连接')
    workspaceId ??= session.workspaceId
  }
  const workspaceRequest = <T>(command: Record<string, unknown>): Promise<T> => { requireAuthority(); return request<T>(command) }
  const media = createDesktopArtworkMedia(requireAuthority, id => workspaceRequest<string | null>({ kind: 'readThumbnail', alias: id }))
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
  async function softDeleteArtworks(ids: Array<string | number>): Promise<ArtworkSoftDeleteResult[]> {
    if (!ids.length || ids.length > ARTWORK_DELETE_BATCH_SIZE) throw new Error('作品删除批次大小无效')
    const requested = ids.slice()
    const uniqueIds = [...new Map(requested.map(id => [String(id).trim(), id])).values()]
    const rows = await workspaceRequest<Array<Row | null>>({ kind: 'getArtworks', ids: uniqueIds })
    const items = rows.filter((item): item is Row => Boolean(item && item.deletedAt === null))
      .map(item => ({ id: item.id, expectedRevision: item.revision }))
    if (!items.length) return requested.map(id => ({ id, deleted: false }))
    const operationId = crypto.randomUUID()
    let receipt: Receipt
    try { receipt = await workspaceRequest<Receipt>({ kind: 'softDeleteArtworks', operationId, items }) }
    catch (error) {
      // A lost response may hide a committed batch. Read its stable receipt before reporting failure.
      const operation = await workspaceRequest<{ state: string; receipt?: Receipt } | null>({ kind: 'getOperation', operationId }).catch(() => null)
      if (operation?.state !== 'committed' || !operation.receipt?.softDeleteResults) throw error
      receipt = operation.receipt
    }
    historyLoaded = false; projectsLoaded = false
    const deleted = new Set((receipt.softDeleteResults ?? []).filter(item => item.deleted).map(item => String(item.id).trim()))
    return requested.map(id => ({ id, deleted: deleted.has(String(id).trim()) }))
  }
  const repository: ArtworkRepository = {
    readHistory, readProjects, readRecentHistory: readHistory, readPreferenceHistory: readHistory,
    async readLibrarySnapshot() { const [history, projects] = await Promise.all([readHistory(), readProjects()]); return { history, projects } },
    ...media,
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
    softDeleteArtworks,
    async restoreArtwork(id) { return { restored: Boolean((await mutate('restoreArtwork', id))?.changed) } },
    async purgeExpiredTrash() { const result = await workspaceRequest<Receipt>({ kind: 'purgeExpiredTrash', operationId: crypto.randomUUID() }); return { purged: result.purged ?? 0 } },
    async listTrash() { return (await list(true)).filter(item => item.deletedAt !== null).map(item => ({ id: String(item.id), deletedAt: item.deletedAt!, historyEntries: [item.body], projectRefs: [], imageIds: item.body.image_id ? [item.body.image_id] : [] })) },
  }
  return { ...repository,
    withStaging: work => trackMaintenanceWrite(work),
    putImage: blob => trackMaintenanceWrite(() => repository.putImage(blob)),
    deleteImage: alias => trackMaintenanceWrite(() => repository.deleteImage(alias)),
    appendArtwork: artwork => trackMaintenanceWrite(() => repository.appendArtwork(artwork)),
    patchArtwork: (id, patch) => trackMaintenanceWrite(() => repository.patchArtwork(id, patch)),
    patchArtworks: patches => trackMaintenanceWrite(() => repository.patchArtworks(patches)),
    deleteArtwork: id => trackMaintenanceWrite(() => repository.deleteArtwork(id)),
    softDeleteArtwork: id => trackMaintenanceWrite(() => repository.softDeleteArtwork(id)),
    softDeleteArtworks: ids => trackMaintenanceWrite(() => repository.softDeleteArtworks(ids)),
    restoreArtwork: id => trackMaintenanceWrite(() => repository.restoreArtwork(id)),
    purgeExpiredTrash: () => trackMaintenanceWrite(() => repository.purgeExpiredTrash()),
  }
}
