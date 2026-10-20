import { ARTWORK_DELETE_BATCH_SIZE, ARTWORK_RESTORE_BATCH_SIZE, type ArtworkRepository, type ArtworkProjectRecord, type ArtworkSoftDeleteResult, type ArtworkRestoreResult } from '../../application/artwork/artworkRepository.ts'
import { artworkTimestamp, parseArtworkRecords, type ArtworkRecord, type ArtworkSearchSummary } from '../../types/artwork.ts'
import { artworkSearchTerms, searchArtworkRecords } from '../../application/artwork/searchIndex.ts'
import { createDesktopArtworkMedia } from './artworkMedia.ts'
import { putDesktopArtworkImage } from './artworkUpload.ts'
import { workspaceRequest as request, WorkspaceRequestError } from '../../api/workspace.ts'
import { getDesktopRuntime, onDesktopRuntime } from './runtime.ts'
import { workspaceMediaAuthority } from './workspaceMediaSource.ts'
import { trackMaintenanceWrite } from '../maintenanceParticipants.ts'
import { preferenceHistoryRows } from '../../application/artwork/preferenceHistory.ts'
import { compareArtworkKeys, parseArtworkSearchPage, parseArtworkRow } from './artworkReadModel.ts'
import { normalizeArtworkOrganization, type ArtworkOrganizationRequest, type ArtworkOrganizationReceipt, type ArtworkOrganizationUndoResult } from '../../application/artwork/organization.ts'
import { normalizeNewArtworkProject, type ArtworkProjectDraft } from '../../application/artwork/projects.ts'
import { normalizeSmartAlbumDraft, normalizeSmartAlbumRemoval, parseSmartAlbumRule, shouldDeleteSmartAlbum, shouldWriteSmartAlbum, SmartAlbumConflictError, type SmartAlbumDraft, type SmartAlbumRemoval } from '../../application/artwork/smartAlbums.ts'
import { createArtworkCommandWriter } from './artworkCommands.ts'

interface Row { id: string | number; body: ArtworkRecord; revision: number; deletedAt: number | null }
interface Page { items: Row[]; nextCursor: string | null; revision: number; artworkRevision: number }
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
  let historyArtworkRevision: number | undefined
  let galleryRead: Promise<ReturnType<typeof import('./artworkGalleryReads.ts')['createDesktopGalleryReads']>> | undefined
  const galleryReads = () => galleryRead ??= import('./artworkGalleryReads.ts').then(module => module.createDesktopGalleryReads(
    workspaceRequest, readProjects, readSession, () => historyLoaded ? loadedHistory : null, () => mutationVersion))
    .catch(error => { galleryRead = undefined; throw error })
  let loadedPreferences: unknown[] | undefined
  let preferenceArtworkRevision: number | undefined
  let loadedSearchIndex: { items: ArtworkSearchSummary[]; query: string; revision: number; session: string; writerEpoch: string } | undefined
  let mutationVersion = 0
  let searchSequence = 0, historySearchSession: string | undefined, snapshotSession: string | undefined
  function searchSession() {
    requireAuthority()
    const runtime = getDesktopRuntime().bootstrap!.runtime!
    return JSON.stringify([runtime.origin, runtime.runtimeEpoch, runtime.workspace!.workspaceId,
      runtime.workspace!.runtimeEpoch, runtime.workspace!.generation])
  }
  function invalidateSearchIndex() { loadedSearchIndex = undefined; searchSequence++ }
  function invalidateSnapshots() {
    mutationVersion++
    historyLoaded = false; projectsLoaded = false; loadedPreferences = undefined
    invalidateSearchIndex()
  }
  function readSession() {
    const session = searchSession()
    if (snapshotSession !== session) {
      if (snapshotSession && getDesktopRuntime().connection !== 'ready') throw new Error('工作区连接已变化，请重新连接后读取')
      historyLoaded = false; projectsLoaded = false; loadedPreferences = undefined
      historySearchSession = undefined; snapshotSession = session
    }
    return session
  }
  function checkReadSession(session: string) {
    if (session !== searchSession()) throw new Error('工作区在读取期间发生变更，请重新读取')
  }
  function writeSession() {
    if (getDesktopRuntime().connection !== 'ready') throw new Error('工作区尚未连接，请重新读取')
    return JSON.stringify([searchSession(), getDesktopRuntime().bootstrap!.runtime!.workspace!.principalId])
  }
  const writeArtworkCommand = createArtworkCommandWriter(workspaceRequest, writeSession, invalidateSnapshots)

  async function list(selection: 'live' | 'deleted' = 'live', projection?: 'preference', signal?: AbortSignal): Promise<{ rows: Row[]; artworkRevision: number }> {
    const rows: Row[] = []
    let cursor: string | null = null
    let artworkRevision: number | undefined
    do {
      signal?.throwIfAborted()
      const page: Page = await workspaceRequest({ kind: 'listArtworks', limit: 200, ...(selection === 'deleted' ? { deletedOnly: true } : {}), ...(projection ? { projection } : {}), ...(cursor ? { cursor } : {}) }, signal)
      signal?.throwIfAborted()
      if (!Number.isSafeInteger(page.revision) || page.revision < 0 || !Number.isSafeInteger(page.artworkRevision) || page.artworkRevision < 0) throw new Error('作品库修订号无效')
      // Artwork triggers cover every row, body and deletion change. Unrelated
      // chat/task writes must not invalidate an otherwise consistent page set.
      if (artworkRevision !== undefined && artworkRevision !== page.artworkRevision) throw new Error('作品库在读取期间发生变更，请重新读取')
      artworkRevision = page.artworkRevision; rows.push(...page.items); cursor = page.nextCursor
    } while (cursor)
    return { rows, artworkRevision: artworkRevision! }
  }
  async function readHistory(signal?: AbortSignal) {
    signal?.throwIfAborted()
    const session = readSession(), version = mutationVersion
    if (getDesktopRuntime().connection !== 'ready' && historyLoaded) return structuredClone(loadedHistory)
    if (historyLoaded) {
      const status = await workspaceRequest<{ artworkRevision: number; writerEpoch: string }>({ kind: 'status' }, signal)
      signal?.throwIfAborted()
      checkReadSession(session)
      if (status.writerEpoch !== getDesktopRuntime().bootstrap!.runtime!.workspace!.runtimeEpoch) throw new Error('工作区连接已变化，请重新读取')
      if (!Number.isSafeInteger(status.artworkRevision) || status.artworkRevision < 0) throw new Error('作品库修订号无效')
      // Revalidate through the live authority on every return. The existing owned
      // snapshot can skip bulk transfer; it never masks a failed status request.
      if (historyLoaded && version === mutationVersion && status.artworkRevision === historyArtworkRevision) return structuredClone(loadedHistory)
    }
    const { rows, artworkRevision } = await list('live', undefined, signal)
    checkReadSession(session)
    const history = parseArtworkRecords(rows.map(row => row.body)).sort((a, b) => artworkTimestamp(b) - artworkTimestamp(a))
    // Gallery may overlay confirmed edits onto this response, but an older read
    // must not revive the invalidated offline cache after a successful write.
    if (version === mutationVersion && (!historyLoaded || artworkRevision >= historyArtworkRevision!)) {
      loadedHistory = history; historyArtworkRevision = artworkRevision; historyLoaded = true; historySearchSession = session
      invalidateSearchIndex()
    }
    return structuredClone(history)
  }
  async function readArtwork(id: string | number, signal?: AbortSignal) {
    signal?.throwIfAborted()
    const raw = await workspaceRequest<unknown>({ kind: 'getArtwork', id }, signal)
    signal?.throwIfAborted()
    const row = parseArtworkRow(raw, id)
    return row?.deletedAt === null ? structuredClone(row.body) : null
  }
  async function searchArtworks(query: string, signal?: AbortSignal) {
    signal?.throwIfAborted()
    const terms = artworkSearchTerms(query), queryKey = JSON.stringify(terms)
    const session = searchSession()
    if (!terms.length) return []
    if (loadedSearchIndex && loadedSearchIndex.session !== session) invalidateSearchIndex()
    if (getDesktopRuntime().connection !== 'ready') {
      if (loadedSearchIndex?.query === queryKey) return structuredClone(loadedSearchIndex.items)
      if (historyLoaded && historySearchSession === session) return searchArtworkRecords(loadedHistory, query)
    }
    const sequence = ++searchSequence
    const writerEpoch = getDesktopRuntime().bootstrap!.runtime!.workspace!.runtimeEpoch
    function checkRead() {
      signal?.throwIfAborted()
      if (searchSession() !== session || searchSequence !== sequence) throw new Error('作品库在读取期间发生变更，请重新读取')
    }
    if (loadedSearchIndex?.query === queryKey) {
      const cached = loadedSearchIndex
      const status = await workspaceRequest<{ artworkRevision: number; writerEpoch: string }>({ kind: 'status' }, signal)
      checkRead()
      if (status.writerEpoch !== writerEpoch) {
        invalidateSearchIndex(); historySearchSession = undefined
        throw new Error('工作区连接已变化，请重新读取')
      }
      if (status.artworkRevision === cached.revision && status.writerEpoch === cached.writerEpoch) return structuredClone(cached.items)
    }
    let items: ArtworkSearchSummary[] = [], cursor: string | null = null, revision: number | undefined
    do {
      checkRead()
      const raw = await workspaceRequest<unknown>({ kind: 'searchArtworks', terms, ...(cursor === null ? {} : { cursor }) }, signal)
      checkRead()
      const page = parseArtworkSearchPage(raw)
      if (revision !== undefined && page.revision !== revision) throw new Error('作品库在读取期间发生变更，请重新读取')
      if (page.nextCursor !== null && cursor !== null && compareArtworkKeys(page.nextCursor, cursor) <= 0) throw new Error('作品搜索游标无效')
      revision = page.revision
      items = [...items, ...page.items].sort((a, b) => artworkTimestamp(b) - artworkTimestamp(a) || compareArtworkKeys(a.id, b.id)).slice(0, 5)
      cursor = page.nextCursor
    } while (cursor !== null)
    loadedSearchIndex = { items: structuredClone(items), query: queryKey, revision: revision!, session, writerEpoch }
    return items
  }
  async function readPreferenceHistory() {
    const session = readSession(), version = mutationVersion
    if (getDesktopRuntime().connection !== 'ready' && (loadedPreferences || historyLoaded)) return preferenceHistoryRows(loadedPreferences ?? loadedHistory)
    if (loadedPreferences) {
      const status = await workspaceRequest<{ artworkRevision: number; writerEpoch: string }>({ kind: 'status' })
      checkReadSession(session)
      if (status.writerEpoch !== getDesktopRuntime().bootstrap!.runtime!.workspace!.runtimeEpoch) throw new Error('工作区连接已变化，请重新读取')
      if (!Number.isSafeInteger(status.artworkRevision) || status.artworkRevision < 0) throw new Error('作品库修订号无效')
      // Reuse only this projection's confirmed rows: full history has different
      // filtering and order. A failed authority read must never become a cache hit.
      if (loadedPreferences && version === mutationVersion && status.artworkRevision === preferenceArtworkRevision) return structuredClone(loadedPreferences)
    }
    const { rows, artworkRevision } = await list('live', 'preference')
    checkReadSession(session)
    const preferences = preferenceHistoryRows(rows.map(row => row.body))
    if (version === mutationVersion && (!loadedPreferences || artworkRevision >= preferenceArtworkRevision!)) {
      loadedPreferences = preferences; preferenceArtworkRevision = artworkRevision
    }
    return structuredClone(preferences)
  }
  async function readProjects() {
    const session = readSession(), version = mutationVersion
    if (getDesktopRuntime().connection !== 'ready' && projectsLoaded) return structuredClone(loadedProjects)
    const result = await workspaceRequest<{ items: Array<{ body: ArtworkProjectRecord }> }>({ kind: 'listProjects' })
    checkReadSession(session)
    const projects = result.items.map(item => item.body)
    if (version === mutationVersion) { loadedProjects = projects; projectsLoaded = true }
    return structuredClone(projects)
  }
  const row = (id: string | number) => workspaceRequest<Row | null>({ kind: 'getArtwork', id })
  async function mutate(kind: string, id: string | number, extra: Record<string, unknown> = {}): Promise<Receipt | null> {
    const session = writeSession(), snapshot = structuredClone(extra)
    const current = parseArtworkRow(await row(id), id)
    if (session !== writeSession()) throw new Error('工作区在操作期间发生变更，请重新读取')
    if (!current) { invalidateSnapshots(); return null }
    return writeArtworkCommand({ ...snapshot, kind, id, operationId: crypto.randomUUID(), expectedRevision: current.revision }, value => {
      if (typeof value.changed !== 'boolean') throw new Error('作品操作回执无效')
      const artwork = parseArtworkRow(value.artwork, id)
      if (!artwork || (value.changed && artwork.revision !== value.revision)) throw new Error('作品操作回执无效')
      return structuredClone(value) as Receipt
    })
  }
  async function softDeleteArtworks(ids: Array<string | number>): Promise<ArtworkSoftDeleteResult[]> {
    if (!ids.length || ids.length > ARTWORK_DELETE_BATCH_SIZE) throw new Error('作品删除批次大小无效')
    const requested = ids.slice()
    const uniqueIds = [...new Map(requested.map(id => [String(id).trim(), id])).values()]
    const rows = await workspaceRequest<Array<Row | null>>({ kind: 'getArtworks', ids: uniqueIds, projection: 'revision' })
    const items = rows.filter((item): item is Row => Boolean(item && item.deletedAt === null))
      .map(item => ({ id: item.id, expectedRevision: item.revision }))
    if (!items.length) return requested.map(id => ({ id, deleted: false }))
    const receipt = await writeArtworkCommand<Receipt>({ kind: 'softDeleteArtworks', operationId: crypto.randomUUID(), items })
    const deleted = new Set((receipt.softDeleteResults ?? []).filter(item => item.deleted).map(item => String(item.id).trim()))
    return requested.map(id => ({ id, deleted: deleted.has(String(id).trim()) }))
  }
  async function restoreArtworks(ids: Array<string | number>): Promise<ArtworkRestoreResult[]> {
    if (!Array.isArray(ids) || !ids.length || ids.length > ARTWORK_RESTORE_BATCH_SIZE
      || parseArtworkRecords(ids.map(id => ({ id }))).length !== ids.length) throw new Error('作品恢复批次无效')
    const requested = ids.slice()
    const key = (id: string | number) => String(id).trim()
    const uniqueIds = [...new Map(requested.map(id => [key(id), id])).values()]
    const rows = await workspaceRequest<unknown>({ kind: 'getArtworks', ids: uniqueIds, projection: 'revision' })
    if (!Array.isArray(rows) || rows.length !== uniqueIds.length) throw new Error('作品响应无效')
    const items = rows.map((row, index) => parseArtworkRow(row, uniqueIds[index]))
      .filter((row): row is Row => row !== null)
      .map(row => ({ id: row.id, expectedRevision: row.revision }))
    if (!items.length) return requested.map(id => ({ id, restored: false }))
    const receipt = await writeArtworkCommand<{ restoreResults: unknown }>({ kind: 'restoreArtworks', operationId: crypto.randomUUID(), items })
    if (!Array.isArray(receipt.restoreResults) || receipt.restoreResults.length !== items.length) throw new Error('作品恢复回执无效')
    const outcomes = new Map<string, ArtworkRestoreResult>()
    receipt.restoreResults.forEach((raw: unknown, index: number) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('作品恢复回执无效')
      const result = raw as ArtworkRestoreResult
      if (!parseArtworkRecords([result]).length || key(result.id) !== key(items[index].id)
        || typeof result.restored !== 'boolean' || outcomes.has(key(result.id))
        || (result.code !== undefined && (typeof result.code !== 'string' || !result.code))
        || (result.missingImageIds !== undefined && (!Array.isArray(result.missingImageIds) || result.missingImageIds.some(id => typeof id !== 'string')))
        || (result.restored && (result.code !== undefined || result.missingImageIds?.length))) throw new Error('作品恢复回执无效')
      outcomes.set(key(result.id), result)
    })
    return requested.map(id => structuredClone({ ...(outcomes.get(key(id)) ?? { restored: false }), id }))
  }
  async function organizeArtworks(input: ArtworkOrganizationRequest) {
    const normalized = normalizeArtworkOrganization(structuredClone(input))
    const rows = await workspaceRequest<unknown>({ kind: 'getArtworks', ids: normalized.ids, projection: 'revision' })
    if (!Array.isArray(rows) || rows.length !== normalized.ids.length) throw new Error('作品响应无效')
    const expectedRevisions = rows.map((row, index) => {
      const parsed = parseArtworkRow(row, normalized.ids[index])
      if (!parsed || parsed.deletedAt !== null) throw new Error('部分作品已不在作品册，请重新读取后选择')
      return { id: parsed.id, revision: parsed.revision }
    })
    return writeArtworkCommand<ArtworkOrganizationReceipt>({ kind: 'organizeArtworks', operationId: `organize-${crypto.randomUUID()}`, ...normalized, expectedRevisions })
  }
  function undoArtworkOrganization(receipt: ArtworkOrganizationReceipt) {
    return writeArtworkCommand<ArtworkOrganizationUndoResult>({ kind: 'undoArtworkOrganization', operationId: `undo-${crypto.randomUUID()}`, sourceOperationId: receipt.operationId })
  }
  async function createProject(input: ArtworkProjectDraft) {
    const project = normalizeNewArtworkProject(input)
    const receipt = await writeArtworkCommand<{ project: { body: ArtworkProjectRecord } }>({
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
  function captureProjectWriteSession() {
    const session = writeSession()
    let current = true
    const check = () => {
      if (!current || writeSession() !== session) throw new Error('工作区连接已变化，请重新核对画册')
    }
    const release = onDesktopRuntime(() => {
      try { check() } catch { current = false }
    })
    return { check, release }
  }
  async function saveSmartAlbum(input: SmartAlbumDraft) {
    const draft = normalizeSmartAlbumDraft(input), source = captureProjectWriteSession()
    try {
      const projects = await projectRows()
      source.check()
      const current = projects.find(row => String(row.id).trim() === draft.id)
      if (!shouldWriteSmartAlbum(current?.body, draft)) return structuredClone(current!.body)
      if (draft.rule.projectId) {
        const manual = projects.find(row => String(row.id).trim() === draft.rule.projectId)
        if (!manual || Object.hasOwn(manual.body, 'smartRule') || draft.rule.projectId === draft.id) throw new Error('智能画册只能筛选已有的手动画册')
      }
      const project = { ...current?.body, id: current?.id ?? draft.id, title: draft.title, history_ids: [], smartRule: draft.rule }
      const receipt = await writeArtworkCommand<{ project: ProjectRow }>({ kind: 'saveProject',
        operationId: `smart-album-${crypto.randomUUID()}`, project, artworkIds: [], expectedRevision: current?.revision ?? null })
      const saved = receipt?.project?.body
      if (!saved || String(receipt.project.id).trim() !== draft.id || !Number.isSafeInteger(receipt.project.revision)
        || receipt.project.revision < 0 || String(saved.id).trim() !== draft.id || saved.title !== draft.title
        || !Array.isArray(saved.history_ids) || saved.history_ids.length
        || JSON.stringify(parseSmartAlbumRule(saved.smartRule)) !== JSON.stringify(draft.rule)) throw new Error('智能画册保存响应无效，请重新读取')
      return structuredClone(saved)
    } catch (cause) {
      if (cause instanceof WorkspaceRequestError && cause.status === 409 && cause.code === 'REVISION_CONFLICT') {
        throw new SmartAlbumConflictError('智能画册已在其他位置修改，当前输入已保留；请核对最新内容后重新打开', { cause })
      }
      throw cause
    } finally { source.release() }
  }
  async function deleteSmartAlbum(input: SmartAlbumRemoval) {
    const removal = normalizeSmartAlbumRemoval(input), source = captureProjectWriteSession()
    try {
      const current = (await projectRows()).find(row => String(row.id).trim() === removal.id)
      source.check()
      if (!shouldDeleteSmartAlbum(current?.body, removal)) return { deleted: false }
      const receipt = await writeArtworkCommand<{ deleted: boolean; id: unknown }>({ kind: 'deleteSmartAlbum',
        id: current!.id, operationId: `delete-smart-album-${crypto.randomUUID()}`, expectedRevision: current!.revision })
      if (typeof receipt?.deleted !== 'boolean' || String(receipt.id).trim() !== removal.id) throw new Error('智能画册删除响应无效，请重新读取')
      return { deleted: receipt.deleted }
    } catch (cause) {
      if (cause instanceof WorkspaceRequestError && cause.status === 409 && cause.code === 'REVISION_CONFLICT') {
        throw new SmartAlbumConflictError('画册内容已变化，请重新核对后移除', { cause })
      }
      throw cause
    } finally { source.release() }
  }
  const repository: ArtworkRepository = {
    readHistory, readArtwork, searchArtworks, readProjects, readPreferenceHistory,
    readRecentHistory: (...args) => galleryReads().then(reader => reader.readRecentHistory(...args)),
    organizeArtworks, undoArtworkOrganization, createProject, saveSmartAlbum, deleteSmartAlbum,
    async readLibrarySnapshot() { const [history, projects] = await Promise.all([readHistory(), readProjects()]); return { history, projects } },
    readGallerySnapshot: (...args) => galleryReads().then(reader => reader.readGallerySnapshot(...args)),
    getPreview: (...args) => galleryReads().then(reader => reader.getPreview(...args)),
    ...media,
    getWorkspaceMediaReference(alias) {
      requireAuthority()
      return { alias, authority: workspaceMediaAuthority() }
    },
    putImage: blob => putDesktopArtworkImage(blob, workspaceRequest),
    async resolveArtworkImport(input, command, access) {
      const snapshot = structuredClone(input), action = { ...command }
      try {
        const { importDesktopArtwork } = await import('./artworkImport.ts')
        access.check()
        return await importDesktopArtwork(snapshot, action, access, workspaceRequest)
      } finally { invalidateSnapshots() }
    },
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
      invalidateSnapshots()
    },
    async patchArtwork(id, patch) { return { updated: Boolean((await mutate('patchArtwork', id, { patch }))?.changed) } },
    async patchArtworks(patches) { for (const item of patches) await mutate('patchArtwork', item.id, { patch: item.patch }) },
    async softDeleteArtwork(id) { return { deleted: Boolean((await mutate('softDeleteArtwork', id))?.changed) } },
    softDeleteArtworks,
    async restoreArtwork(id) { return { restored: Boolean((await mutate('restoreArtwork', id))?.changed) } },
    restoreArtworks,
    async purgeExpiredTrash() { const result = await workspaceRequest<Receipt>({ kind: 'purgeExpiredTrash', operationId: crypto.randomUUID() }); return { purged: result.purged ?? 0 } },
    async purgeTrash(entries) {
      const snapshot = structuredClone(entries)
      let purged = 0
      for (let offset = 0; offset < snapshot.length; offset += ARTWORK_DELETE_BATCH_SIZE) {
        const result = await writeArtworkCommand<Receipt>({ kind: 'purgeTrash', operationId: `purge-${crypto.randomUUID()}`, entries: snapshot.slice(offset, offset + ARTWORK_DELETE_BATCH_SIZE) })
        purged += result.purged ?? 0
      }
      return { purged }
    },
    async listTrash() {
      const session = readSession()
      const { rows } = await list('deleted')
      checkReadSession(session)
      return rows.filter(item => item.deletedAt !== null).map(item => ({ id: String(item.id), deletedAt: item.deletedAt!, historyEntries: [item.body], projectRefs: [], imageIds: item.body.image_id ? [item.body.image_id] : [] }))
    },
  }
  return { ...repository,
    withStaging: work => trackMaintenanceWrite(work),
    putImage: blob => trackMaintenanceWrite(() => repository.putImage(blob)),
    resolveArtworkImport: (...args) => trackMaintenanceWrite(() => repository.resolveArtworkImport(...args)),
    deleteImage: alias => trackMaintenanceWrite(() => repository.deleteImage(alias)),
    appendArtwork: artwork => trackMaintenanceWrite(() => repository.appendArtwork(artwork)),
    createProject: input => trackMaintenanceWrite(() => repository.createProject(input)),
    saveSmartAlbum: input => trackMaintenanceWrite(() => repository.saveSmartAlbum(input)),
    deleteSmartAlbum: input => trackMaintenanceWrite(() => repository.deleteSmartAlbum(input)),
    organizeArtworks: input => trackMaintenanceWrite(() => repository.organizeArtworks(input)),
    undoArtworkOrganization: receipt => trackMaintenanceWrite(() => repository.undoArtworkOrganization(receipt)),
    patchArtwork: (id, patch) => trackMaintenanceWrite(() => repository.patchArtwork(id, patch)),
    patchArtworks: patches => trackMaintenanceWrite(() => repository.patchArtworks(patches)),
    softDeleteArtwork: id => trackMaintenanceWrite(() => repository.softDeleteArtwork(id)),
    softDeleteArtworks: ids => trackMaintenanceWrite(() => repository.softDeleteArtworks(ids)),
    restoreArtwork: id => trackMaintenanceWrite(() => repository.restoreArtwork(id)),
    restoreArtworks: ids => trackMaintenanceWrite(() => repository.restoreArtworks(ids)),
    purgeExpiredTrash: () => trackMaintenanceWrite(() => repository.purgeExpiredTrash()),
    purgeTrash: entries => trackMaintenanceWrite(() => repository.purgeTrash(entries)),
  }
}
