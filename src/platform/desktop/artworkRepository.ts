import { ARTWORK_DELETE_BATCH_SIZE, type ArtworkRepository, type ArtworkProjectRecord, type ArtworkSoftDeleteResult } from '../../application/artwork/artworkRepository.ts'
import { artworkTimestamp, parseArtworkRecords, type ArtworkRecord, type ArtworkSearchRecord } from '../../types/artwork.ts'
import { buildArtworkSearchIndex, parseArtworkSearchIndex } from '../../application/artwork/searchIndex.ts'
import { createDesktopArtworkMedia } from './artworkMedia.ts'
import { putDesktopArtworkImage } from './artworkUpload.ts'
import { workspaceRequest as request } from '../../api/workspace.ts'
import { getDesktopRuntime } from './runtime.ts'
import { trackMaintenanceWrite } from '../maintenanceParticipants.ts'
import { preferenceHistoryRows } from '../../application/artwork/preferenceHistory.ts'
import { parseArtworkRow, parseArtworkRecentIndex } from './artworkReadModel.ts'
import { normalizeArtworkOrganization, type ArtworkOrganizationRequest, type ArtworkOrganizationReceipt, type ArtworkOrganizationUndoResult } from '../../application/artwork/organization.ts'
import { normalizeNewArtworkProject, type ArtworkProjectDraft } from '../../application/artwork/projects.ts'
import { normalizeSmartAlbumDraft, parseSmartAlbumRule, type SmartAlbumDraft } from '../../application/artwork/smartAlbums.ts'

interface Row { id: string | number; body: ArtworkRecord; revision: number; deletedAt: number | null }
interface Page { items: Row[]; nextCursor: string | null; revision: number }
interface Receipt { artwork?: Row; changed?: boolean; removed?: number; purged?: number; softDeleteResults?: ArtworkSoftDeleteResult[] }
interface ProjectRow { id: string | number; body: ArtworkProjectRecord; revision: number }
export function createDesktopArtworkRepository(): ArtworkRepository {
  let workspaceId = getDesktopRuntime().bootstrap?.runtime?.workspace?.workspaceId
  function requireAuthority() {
    const session = getDesktopRuntime().bootstrap?.runtime?.workspace
    if (!session?.domains.includes('artwork') || (workspaceId && workspaceId !== session.workspaceId)) throw new Error('作品库身份尚未确认，请重新连接')
    workspaceId ??= session.workspaceId
  }
  const workspaceRequest = <T>(command: Record<string, unknown>, signal?: AbortSignal): Promise<T> => { requireAuthority(); return request<T>(command, signal) }
  const { forgetThumbnail, ...media } = createDesktopArtworkMedia(requireAuthority, id => workspaceRequest<string | null>({ kind: 'readThumbnail', alias: id }))
  let loadedHistory: ArtworkRecord[] = [], loadedProjects: ArtworkProjectRecord[] = []
  let historyLoaded = false, projectsLoaded = false
  let loadedRecent: ArtworkRecord[] = [], recentLoaded = false
  let loadedPreferences: unknown[] | undefined
  let loadedSearchIndex: { items: ArtworkSearchRecord[]; revision: number; session: string; writerEpoch: string } | undefined
  let searchSequence = 0, historySearchSession: string | undefined, snapshotSession: string | undefined
  function searchSession() {
    requireAuthority()
    const runtime = getDesktopRuntime().bootstrap!.runtime!
    return JSON.stringify([runtime.origin, runtime.runtimeEpoch, runtime.workspace!.workspaceId,
      runtime.workspace!.runtimeEpoch, runtime.workspace!.generation])
  }
  function invalidateSearchIndex() { loadedSearchIndex = undefined; searchSequence++ }
  function readSession() {
    const session = searchSession()
    if (snapshotSession !== session) {
      if (snapshotSession && getDesktopRuntime().connection !== 'ready') throw new Error('工作区连接已变化，请重新连接后读取')
      historyLoaded = false; projectsLoaded = false; recentLoaded = false; loadedPreferences = undefined
      historySearchSession = undefined; snapshotSession = session
    }
    return session
  }
  function checkReadSession(session: string) {
    if (session !== searchSession()) throw new Error('工作区在读取期间发生变更，请重新读取')
  }

  async function list(includeDeleted = false, projection?: 'preference', signal?: AbortSignal): Promise<Row[]> {
    const rows: Row[] = []
    let cursor: string | null = null
    let revision: number | undefined
    do {
      signal?.throwIfAborted()
      const page: Page = await workspaceRequest({ kind: 'listArtworks', limit: 200, includeDeleted, ...(projection ? { projection } : {}), ...(cursor ? { cursor } : {}) }, signal)
      signal?.throwIfAborted()
      if (revision !== undefined && revision !== page.revision) throw new Error('作品库在读取期间发生变更，请重新读取')
      revision = page.revision; rows.push(...page.items); cursor = page.nextCursor
    } while (cursor)
    return rows
  }
  async function readHistory(signal?: AbortSignal) {
    signal?.throwIfAborted()
    const session = readSession()
    if (getDesktopRuntime().connection !== 'ready' && historyLoaded) return structuredClone(loadedHistory)
    const rows = await list(false, undefined, signal)
    checkReadSession(session)
    loadedHistory = parseArtworkRecords(rows.map(row => row.body)).sort((a, b) => artworkTimestamp(b) - artworkTimestamp(a))
    historyLoaded = true
    historySearchSession = session
    recentLoaded = false
    invalidateSearchIndex()
    return structuredClone(loadedHistory)
  }
  async function readArtwork(id: string | number, signal?: AbortSignal) {
    signal?.throwIfAborted()
    const raw = await workspaceRequest<unknown>({ kind: 'getArtwork', id }, signal)
    signal?.throwIfAborted()
    const row = parseArtworkRow(raw, id)
    return row?.deletedAt === null ? structuredClone(row.body) : null
  }
  async function readRecentHistory(signal?: AbortSignal) {
    signal?.throwIfAborted()
    const session = readSession()
    if (getDesktopRuntime().connection !== 'ready' && (historyLoaded || recentLoaded)) {
      return structuredClone((recentLoaded ? loadedRecent : loadedHistory).slice(0, 3))
    }
    // Bound numeric candidates on the backend; legacy timestamps still use JS
    // Date/id fallback and stable identity ties. Fetch only three full bodies.
    const result = await workspaceRequest<unknown>({ kind: 'readArtworkRecentIndex', candidateLimit: 3 }, signal)
    signal?.throwIfAborted()
    const selected = parseArtworkRecentIndex(result).sort((a, b) => artworkTimestamp(b) - artworkTimestamp(a)).slice(0, 3)
    const rows = selected.length
      ? await workspaceRequest<unknown>({ kind: 'getArtworks', ids: selected.map(row => row.id) }, signal) : []
    signal?.throwIfAborted()
    if (!Array.isArray(rows) || rows.length !== selected.length) throw new Error('最近作品响应无效')
    const parsed = rows.map((row, index) => parseArtworkRow(row, selected[index].id))
    if (parsed.some((row, index) => !row || row.deletedAt !== null || row.revision !== selected[index].revision)) {
      throw new Error('作品库在读取期间发生变更，请重新读取')
    }
    checkReadSession(session)
    const recent = structuredClone(parsed.map(row => row!.body))
    loadedRecent = recent; recentLoaded = true
    return structuredClone(loadedRecent)
  }
  async function readSearchIndex(signal?: AbortSignal) {
    signal?.throwIfAborted()
    const session = searchSession()
    if (loadedSearchIndex && loadedSearchIndex.session !== session) invalidateSearchIndex()
    if (getDesktopRuntime().connection !== 'ready') {
      if (loadedSearchIndex) return structuredClone(loadedSearchIndex.items)
      if (historyLoaded && historySearchSession === session) return buildArtworkSearchIndex(loadedHistory)
    }
    const sequence = ++searchSequence
    const writerEpoch = getDesktopRuntime().bootstrap!.runtime!.workspace!.runtimeEpoch
    function checkRead() {
      signal?.throwIfAborted()
      if (searchSession() !== session || searchSequence !== sequence) throw new Error('作品库在读取期间发生变更，请重新读取')
    }
    if (loadedSearchIndex) {
      const cached = loadedSearchIndex
      checkRead()
      const status = await workspaceRequest<{ revision: number; writerEpoch: string }>({ kind: 'status' }, signal)
      checkRead()
      if (status.writerEpoch !== writerEpoch) {
        invalidateSearchIndex(); historySearchSession = undefined
        throw new Error('工作区连接已变化，请重新读取')
      }
      if (status.revision === cached.revision && status.writerEpoch === cached.writerEpoch) return structuredClone(cached.items)
    }
    checkRead()
    const result = await workspaceRequest<{ items: unknown; revision: number }>({ kind: 'readArtworkSearchIndex' }, signal)
    checkRead()
    if (!Number.isSafeInteger(result.revision) || result.revision < 0) throw new Error('作品搜索索引无效')
    // The index owns its revision: a status read must never relabel an older snapshot.
    loadedSearchIndex = { items: parseArtworkSearchIndex(result.items), revision: result.revision, session, writerEpoch }
    return structuredClone(loadedSearchIndex.items)
  }
  async function readPreferenceHistory() {
    const session = readSession()
    if (getDesktopRuntime().connection !== 'ready' && (loadedPreferences || historyLoaded)) return preferenceHistoryRows(loadedPreferences ?? loadedHistory)
    const rows = await list(false, 'preference')
    checkReadSession(session)
    loadedPreferences = preferenceHistoryRows(rows.map(row => row.body))
    return structuredClone(loadedPreferences)
  }
  async function readProjects() {
    const session = readSession()
    if (getDesktopRuntime().connection !== 'ready' && projectsLoaded) return structuredClone(loadedProjects)
    const result = await workspaceRequest<{ items: Array<{ body: ArtworkProjectRecord }> }>({ kind: 'listProjects' })
    checkReadSession(session)
    loadedProjects = result.items.map(item => item.body); projectsLoaded = true
    return structuredClone(loadedProjects)
  }
  const row = (id: string | number) => workspaceRequest<Row | null>({ kind: 'getArtwork', id })
  async function mutate(kind: string, id: string | number, extra: Record<string, unknown> = {}): Promise<Receipt | null> {
    const current = await row(id)
    if (!current) return null
    const result = await workspaceRequest<Receipt>({ kind, id, operationId: crypto.randomUUID(), expectedRevision: current.revision, ...extra })
    historyLoaded = false; projectsLoaded = false; recentLoaded = false
    invalidateSearchIndex()
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
    historyLoaded = false; projectsLoaded = false; recentLoaded = false
    invalidateSearchIndex()
    const deleted = new Set((receipt.softDeleteResults ?? []).filter(item => item.deleted).map(item => String(item.id).trim()))
    return requested.map(id => ({ id, deleted: deleted.has(String(id).trim()) }))
  }
  async function organizationWrite<T>(command: Record<string, unknown>): Promise<T> {
    let result: T
    try { result = await workspaceRequest<T>(command) }
    catch (error) {
      const operation = await workspaceRequest<{ state: string; receipt?: T } | null>({ kind: 'getOperation', operationId: command.operationId }).catch(() => null)
      if (operation?.state !== 'committed' || !operation.receipt) throw error
      result = operation.receipt
    }
    historyLoaded = false; projectsLoaded = false; recentLoaded = false; loadedPreferences = undefined; invalidateSearchIndex()
    return structuredClone(result)
  }
  async function organizeArtworks(input: ArtworkOrganizationRequest) {
    const normalized = normalizeArtworkOrganization(structuredClone(input))
    const rows = await workspaceRequest<unknown>({ kind: 'getArtworks', ids: normalized.ids })
    if (!Array.isArray(rows) || rows.length !== normalized.ids.length) throw new Error('作品响应无效')
    const expectedRevisions = rows.map((row, index) => {
      const parsed = parseArtworkRow(row, normalized.ids[index])
      if (!parsed || parsed.deletedAt !== null) throw new Error('部分作品已不在作品册，请重新读取后选择')
      return { id: parsed.id, revision: parsed.revision }
    })
    return organizationWrite<ArtworkOrganizationReceipt>({ kind: 'organizeArtworks', operationId: `organize-${crypto.randomUUID()}`, ...normalized, expectedRevisions })
  }
  function undoArtworkOrganization(receipt: ArtworkOrganizationReceipt) {
    return organizationWrite<ArtworkOrganizationUndoResult>({ kind: 'undoArtworkOrganization', operationId: `undo-${crypto.randomUUID()}`, sourceOperationId: receipt.operationId })
  }
  async function createProject(input: ArtworkProjectDraft) {
    const project = normalizeNewArtworkProject(input)
    const receipt = await organizationWrite<{ project: { body: ArtworkProjectRecord } }>({
      kind: 'saveProject', operationId: `create-project:${project.id}`, project, artworkIds: [], expectedRevision: null,
    })
    const saved = receipt?.project?.body
    if (saved?.id !== project.id || saved.title !== project.title) throw new Error('画册创建响应无效，请重试本次创建')
    return structuredClone(saved)
  }
  async function projectRows(): Promise<ProjectRow[]> {
    const result = await workspaceRequest<{ items: ProjectRow[] }>({ kind: 'listProjects' })
    if (!Array.isArray(result?.items) || result.items.some(row => !row?.body || typeof row.body !== 'object'
      || Array.isArray(row.body) || !['string', 'number'].includes(typeof row.id)
      || !String(row.id).trim() || (typeof row.id === 'number' && !Number.isFinite(row.id))
      || String(row.body.id).trim() !== String(row.id).trim()
      || !Number.isSafeInteger(row.revision) || row.revision < 0)) throw new Error('画册响应无效')
    if (new Set(result.items.map(row => String(row.id).trim())).size !== result.items.length) throw new Error('画册响应无效')
    return structuredClone(result.items)
  }
  async function saveSmartAlbum(input: SmartAlbumDraft) {
    const draft = normalizeSmartAlbumDraft(input), projects = await projectRows()
    const current = projects.find(row => String(row.id).trim() === draft.id)
    if (current && !Object.hasOwn(current.body, 'smartRule')) throw new Error('画册编号已被手动画册使用')
    if (draft.rule.projectId) {
      const manual = projects.find(row => String(row.id).trim() === draft.rule.projectId)
      if (!manual || Object.hasOwn(manual.body, 'smartRule') || draft.rule.projectId === draft.id) throw new Error('智能画册只能筛选已有的手动画册')
    }
    const project = { ...current?.body, id: current?.id ?? draft.id, title: draft.title, history_ids: [], smartRule: draft.rule }
    if (current && JSON.stringify(current.body) === JSON.stringify(project)) return structuredClone(current.body)
    const receipt = await organizationWrite<{ project: ProjectRow }>({ kind: 'saveProject',
      operationId: `smart-album-${crypto.randomUUID()}`, project, artworkIds: [], expectedRevision: current?.revision ?? null })
    const saved = receipt?.project?.body
    if (!saved || String(receipt.project.id).trim() !== draft.id || !Number.isSafeInteger(receipt.project.revision)
      || receipt.project.revision < 0 || String(saved.id).trim() !== draft.id || saved.title !== draft.title
      || !Array.isArray(saved.history_ids) || saved.history_ids.length
      || JSON.stringify(parseSmartAlbumRule(saved.smartRule)) !== JSON.stringify(draft.rule)) throw new Error('智能画册保存响应无效，请重新读取')
    return structuredClone(saved)
  }
  async function deleteSmartAlbum(id: string) {
    const target = typeof id === 'string' ? id.trim() : ''
    if (!target) throw new Error('画册编号无效')
    const current = (await projectRows()).find(row => String(row.id).trim() === target)
    if (!current) return { deleted: false }
    if (!Object.hasOwn(current.body, 'smartRule') || !parseSmartAlbumRule(current.body.smartRule)) throw new Error('只能删除有效的智能画册')
    const receipt = await organizationWrite<{ deleted: boolean; id: unknown }>({ kind: 'deleteSmartAlbum',
      id: current.id, operationId: `delete-smart-album-${crypto.randomUUID()}`, expectedRevision: current.revision })
    if (typeof receipt?.deleted !== 'boolean' || String(receipt.id).trim() !== target) throw new Error('智能画册删除响应无效，请重新读取')
    return { deleted: receipt.deleted }
  }
  const repository: ArtworkRepository = {
    readHistory, readArtwork, readSearchIndex, readProjects, readRecentHistory, readPreferenceHistory,
    organizeArtworks, undoArtworkOrganization, createProject, saveSmartAlbum, deleteSmartAlbum,
    async readLibrarySnapshot() { const [history, projects] = await Promise.all([readHistory(), readProjects()]); return { history, projects } },
    ...media,
    putImage: blob => putDesktopArtworkImage(blob, workspaceRequest),
    async deleteImage(alias) {
      await workspaceRequest({ kind: 'releaseMedia', alias, operationId: crypto.randomUUID() })
      forgetThumbnail(alias)
    },
    countImages: () => workspaceRequest<number>({ kind: 'countMedia' }),
    withStaging: work => work(),
    async appendArtwork(artwork) {
      // Entity identity is the retry key. Lost acknowledgements can safely re-read
      // the same record without generating another artwork or releasing its media.
      await workspaceRequest({ kind: 'appendArtwork', operationId: `artwork:${String(artwork.id)}`, artwork: structuredClone(artwork) })
      historyLoaded = false
      recentLoaded = false
      invalidateSearchIndex()
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
    async purgeTrash(entries) {
      const snapshot = structuredClone(entries)
      let purged = 0
      for (let offset = 0; offset < snapshot.length; offset += ARTWORK_DELETE_BATCH_SIZE) {
        const result = await organizationWrite<Receipt>({ kind: 'purgeTrash', operationId: `purge-${crypto.randomUUID()}`, entries: snapshot.slice(offset, offset + ARTWORK_DELETE_BATCH_SIZE) })
        purged += result.purged ?? 0
      }
      return { purged }
    },
    async listTrash() { return (await list(true)).filter(item => item.deletedAt !== null).map(item => ({ id: String(item.id), deletedAt: item.deletedAt!, historyEntries: [item.body], projectRefs: [], imageIds: item.body.image_id ? [item.body.image_id] : [] })) },
  }
  return { ...repository,
    withStaging: work => trackMaintenanceWrite(work),
    putImage: blob => trackMaintenanceWrite(() => repository.putImage(blob)),
    deleteImage: alias => trackMaintenanceWrite(() => repository.deleteImage(alias)),
    appendArtwork: artwork => trackMaintenanceWrite(() => repository.appendArtwork(artwork)),
    createProject: input => trackMaintenanceWrite(() => repository.createProject(input)),
    saveSmartAlbum: input => trackMaintenanceWrite(() => repository.saveSmartAlbum(input)),
    deleteSmartAlbum: id => trackMaintenanceWrite(() => repository.deleteSmartAlbum(id)),
    organizeArtworks: input => trackMaintenanceWrite(() => repository.organizeArtworks(input)),
    undoArtworkOrganization: receipt => trackMaintenanceWrite(() => repository.undoArtworkOrganization(receipt)),
    patchArtwork: (id, patch) => trackMaintenanceWrite(() => repository.patchArtwork(id, patch)),
    patchArtworks: patches => trackMaintenanceWrite(() => repository.patchArtworks(patches)),
    deleteArtwork: id => trackMaintenanceWrite(() => repository.deleteArtwork(id)),
    softDeleteArtwork: id => trackMaintenanceWrite(() => repository.softDeleteArtwork(id)),
    softDeleteArtworks: ids => trackMaintenanceWrite(() => repository.softDeleteArtworks(ids)),
    restoreArtwork: id => trackMaintenanceWrite(() => repository.restoreArtwork(id)),
    purgeExpiredTrash: () => trackMaintenanceWrite(() => repository.purgeExpiredTrash()),
    purgeTrash: entries => trackMaintenanceWrite(() => repository.purgeTrash(entries)),
  }
}
