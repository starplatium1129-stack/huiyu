import { kvGet, kvSet, kvSetMany } from '../../composables/useKVStore.ts'
import { withArtworkMutation } from '../../storage/artworkMutation.ts'
import { assertArtworkCleanupCurrent, withArtworkCleanup, withArtworkStaging } from '../../storage/artworkSession.ts'
import { readBrowserImageReferences } from '../../utils/storageReferences.ts'
import { imgDeleteMany, imgGetRecord, imgPutRecord } from '../../composables/useImageStore.ts'
import { parseArtworkRecords, type ArtworkRecord } from '../../types/artwork.ts'
import { ARTWORK_DELETE_BATCH_SIZE, ARTWORK_RESTORE_BATCH_SIZE, type ArtworkRepository, type ArtworkSoftDeleteResult, type ArtworkRestoreResult, type TrashEntry, type ArtworkTrashSelection } from '../../application/artwork/artworkRepository.ts'
import { type ArtworkKvAdapter, type ArtworkImageAdapter, ARTWORK_HISTORY_KEY, ARTWORK_PROJECTS_KEY, ARTWORK_TRASH_KEY, ARTWORK_TRASH_RETENTION_DAYS, record, comparableId, recordId, imageId, unique, arrayValue, callSafely } from './artworkStorage.ts'
import { createArtworkReads } from './artworkReads.ts'
import { createArtworkMedia } from './artworkMedia.ts'
import type { createArtworkOrganization } from './artworkOrganization.ts'
import type { createArtworkProjects } from './artworkProjects.ts'
import { ArtworkTrashConflictError } from '../../application/artwork/artworkMutationOutcome.ts'


export function createWebArtworkRepository(): ArtworkRepository {
  const kv: ArtworkKvAdapter = {
    get: kvGet,
    set: kvSet,
    setMany: kvSetMany,
    remove: key => kvSet(key, null),
  }
  const images: ArtworkImageAdapter = {
    get: imgGetRecord,
    putRecord: imgPutRecord,
    deleteMany: imgDeleteMany,
  }

  // Adapters own their storage isolation; the browser library also serializes across tabs.
  let mutationTail: Promise<void> = Promise.resolve()
  function enqueue<T>(work: () => Promise<T>, cleanup = false): Promise<T> {
    const operation = mutationTail.then(() => cleanup ? withArtworkCleanup(work) : withArtworkMutation(work))
    mutationTail = operation.then(() => undefined, () => undefined)
    return operation
  }

  // ── 软删回收站（2026-08-30 UX 审计 P0-8：作品硬删不可恢复）─────────────
  // 原删除同时清 history 条目 / IndexedDB 原图 / 缩略图，误删 = 原图永久
  // 消失。现在默认路径走软删：可见性立即消失（列表/项目引用移除），但图片
  // 与缩略图保留在原地，快照进 trash KV，30 天内可整条恢复；超期由懒清理
  // 真删。快照只存恢复所需的增量信息，不复制图片数据。

  async function readTrash(): Promise<TrashEntry[]> {
    const snapshot = await kv.get(ARTWORK_TRASH_KEY)
    const list = arrayValue(snapshot)
    return (list || []).filter((item): item is TrashEntry => {
      const entry = record(item)
      return Boolean(entry && comparableId(entry.id) && Array.isArray(entry.historyEntries))
    })
  }

  async function softDeleteArtworksNow(ids: Array<string | number>): Promise<ArtworkSoftDeleteResult[]> {
    if (!ids.length || ids.length > ARTWORK_DELETE_BATCH_SIZE) throw new Error('作品删除批次大小无效')
    const targets = new Set(ids.map(id => { const key = comparableId(id); if (!key) throw new Error('作品 ID 无效'); return key }))
    const [historySnapshot, projectsSnapshot, trash] = await Promise.all([
      kv.get(ARTWORK_HISTORY_KEY),
      kv.get(ARTWORK_PROJECTS_KEY),
      readTrash(),
    ])
    const history = arrayValue(historySnapshot) ?? []
    const removed = new Map<string, unknown[]>()
    const nextHistory: unknown[] = []
    for (const item of history) {
      const key = recordId(item)
      if (!key || !targets.has(key)) { nextHistory.push(item); continue }
      const entries = removed.get(key) ?? []
      entries.push(item); removed.set(key, entries)
    }
    const results = ids.map(id => ({ id, deleted: removed.has(comparableId(id)!) }))
    if (!removed.size) return results
    if (trash.some(entry => removed.has(comparableId(entry.id)!))) throw new ArtworkTrashConflictError()
    const projectRefs = new Map<string, TrashEntry['projectRefs']>()
    let projectsChanged = false
    const nextProjects = (arrayValue(projectsSnapshot) ?? []).map(project => {
      const source = record(project)
      if (!source || !Array.isArray(source.history_ids)) return project
      const matched = new Set<string>()
      const kept = source.history_ids.filter(id => {
        const key = comparableId(id)
        if (!key || !removed.has(key)) return true
        matched.add(key); return false
      })
      for (const key of matched) {
        const refs = projectRefs.get(key) ?? []
        refs.push({ projectId: source.id ?? null, hadReference: true }); projectRefs.set(key, refs)
      }
      if (!matched.size) return project
      projectsChanged = true
      return { ...source, history_ids: kept }
    })
    const remainingImageIds = new Set(unique(nextHistory.map(imageId)))
    const nextTrash = trash.slice()
    const deletedAt = Date.now()
    for (const [id, historyEntries] of removed) nextTrash.push({
      id, deletedAt, historyEntries, projectRefs: projectRefs.get(id) ?? [],
      imageIds: unique(historyEntries.map(imageId)).filter(image => !remainingImageIds.has(image)),
    })
    await kv.setMany([
      { key: ARTWORK_HISTORY_KEY, value: nextHistory },
      ...(projectsChanged ? [{ key: ARTWORK_PROJECTS_KEY, value: nextProjects }] : []),
      { key: ARTWORK_TRASH_KEY, value: nextTrash },
    ])
    return results
  }

  async function restoreArtworkNow(id: string | number): Promise<{ restored: boolean; missingImageIds?: string[] }> {
    const targetId = comparableId(id)
    if (!targetId) throw new Error('作品 ID 无效')

    const trash = await readTrash()
    const entry = trash.find(item => item.id === targetId)
    if (!entry) return { restored: false }

    const [historySnapshot, projectsSnapshot] = await Promise.all([
      kv.get(ARTWORK_HISTORY_KEY),
      kv.get(ARTWORK_PROJECTS_KEY),
    ])
    const history = arrayValue(historySnapshot) ?? []
    if (history.some(item => recordId(item) === targetId)) throw new ArtworkTrashConflictError()
    const requiredImageIds = unique([
      ...(Array.isArray(entry.imageIds) ? entry.imageIds : []),
      ...(Array.isArray(entry.historyEntries) ? entry.historyEntries.map(imageId) : []),
    ])
    const missingImageIds: string[] = []
    for (const image of requiredImageIds) {
      if (!(await images.get(image))) missingImageIds.push(image)
    }
    if (missingImageIds.length) return { restored: false, missingImageIds }
    const restoredId = record(entry.historyEntries.find(item => recordId(item) === targetId))?.id
    if (typeof restoredId !== 'string' && typeof restoredId !== 'number') throw new Error('回收站快照缺少有效作品编号，无法恢复')

    // 项目引用增量补回：只把「快照里有引用、现在没有」的 project 加回该 id，
    // 不整体回写旧快照——恢复期间新建/修改过的 project 不受影响。
    const projects = arrayValue(projectsSnapshot) ?? []
    let refsRestored = 0
    const nextProjects = projects.map(project => {
      const source = record(project)
      const ref = entry.projectRefs.find(r => comparableId(r.projectId) === comparableId(source?.id))
      if (!source || Object.hasOwn(source, 'smartRule') || !ref || !ref.hadReference) return project
      if (!Array.isArray(source.history_ids)) return project
      if (source.history_ids.some(x => comparableId(x) === targetId)) return project
      refsRestored += 1
      return { ...source, history_ids: [...source.history_ids, restoredId] }
    })
    await kv.setMany([
      { key: ARTWORK_HISTORY_KEY, value: [...entry.historyEntries, ...history] },
      ...(refsRestored > 0 ? [{ key: ARTWORK_PROJECTS_KEY, value: nextProjects }] : []),
      { key: ARTWORK_TRASH_KEY, value: trash.filter(item => item.id !== targetId) },
    ])
    return { restored: true }
  }

  async function trashDrafts(): Promise<unknown[]> {
    return readBrowserImageReferences(localStorage, sessionStorage, assertArtworkCleanupCurrent)
  }
  async function purgeExpiredTrashNow(): Promise<{ purged: number }> {
    const { purgeWebTrash } = await import('./artworkTrashPurge.ts')
    assertArtworkCleanupCurrent()
    const trash = await readTrash()
    const deadline = Date.now() - ARTWORK_TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000
    // 刚好到保留期限仍可恢复；非法时间戳保守地保留，避免清理误删快照。
    return purgeWebTrash(kv, images, trash, entry => {
      const deletedAt = Number(entry.deletedAt)
      return Number.isFinite(deletedAt) && deletedAt < deadline
    }, await trashDrafts())
  }
  function purgeTrash(entries: ArtworkTrashSelection[]): Promise<{ purged: number }> {
    const snapshot = structuredClone(entries)
    return enqueue(async () => {
      const { purgeWebTrash } = await import('./artworkTrashPurge.ts')
      assertArtworkCleanupCurrent()
      let purged = 0
      for (let offset = 0; offset < snapshot.length; offset += ARTWORK_DELETE_BATCH_SIZE) {
        const selected = new Map(snapshot.slice(offset, offset + ARTWORK_DELETE_BATCH_SIZE).map(entry => [entry.id, entry.deletedAt]))
        const result = await purgeWebTrash(kv, images, await readTrash(), entry =>
          selected.has(entry.id) && selected.get(entry.id) === entry.deletedAt, await trashDrafts())
        purged += result.purged
      }
      return { purged }
    }, true)
  }

  function softDeleteArtwork(id: string | number): Promise<{ deleted: boolean }> {
    return enqueue(async () => ({ deleted: (await softDeleteArtworksNow([id]))[0].deleted }))
  }

  function softDeleteArtworks(ids: Array<string | number>): Promise<ArtworkSoftDeleteResult[]> {
    const snapshot = ids.slice()
    return enqueue(() => softDeleteArtworksNow(snapshot))
  }

  function restoreArtwork(id: string | number): Promise<{ restored: boolean; missingImageIds?: string[] }> {
    return enqueue(() => restoreArtworkNow(id))
  }

  function restoreArtworks(ids: Array<string | number>): Promise<ArtworkRestoreResult[]> {
    if (!Array.isArray(ids) || !ids.length || ids.length > ARTWORK_RESTORE_BATCH_SIZE
      || parseArtworkRecords(ids.map(id => ({ id }))).length !== ids.length) throw new Error('作品恢复批次无效')
    const snapshot = ids.slice()
    return enqueue(async () => {
      const results: ArtworkRestoreResult[] = []
      const outcomes = new Map<string, Omit<ArtworkRestoreResult, 'id'>>()
      for (const id of snapshot) {
        const key = String(id).trim()
        let result = outcomes.get(key)
        if (!result) {
          try { result = await restoreArtworkNow(id) }
          catch (error) { result = { restored: false, code: error instanceof ArtworkTrashConflictError ? ArtworkTrashConflictError.code : 'RESTORE_UNCONFIRMED' } }
          outcomes.set(key, result)
        }
        results.push(structuredClone({ id, ...result }))
      }
      return results
    })
  }

  function purgeExpiredTrash(): Promise<{ purged: number }> {
    return enqueue(() => purgeExpiredTrashNow(), true)
  }

  /** 列出回收站全部软删条目（2026-08-31 回收站视图用，含删除时间与首图 id）。 */
  function listTrashNow(): Promise<TrashEntry[]> {
    return readTrash().then(entries => structuredClone(entries))
  }

  /**
   * 就地更新一条历史作品的元数据（2026-08-30 UX 审计：收藏是死功能）。
   *
   * 「收藏」筛选与爱心标记一直都在 GalleryView 里，但全库没有任何写入
   * `favorite` 的入口——创建时恒为 false，于是「收藏 N」永远是 0。
   *
   * 只改 history 条目本身，不碰图片 / 缩略图 / 项目引用，因此调用方只应传
   * 标量字段（favorite / notes / rating）。写失败回滚到原快照，与删除共用
   * 同一条 mutationTail 串行链，避免并发写互相覆盖。
   */
  async function patchArtworkNow(
    id: string | number,
    patch: Record<string, unknown>,
  ): Promise<{ updated: boolean }> {
    const targetId = comparableId(id)
    if (!targetId) throw new Error('作品 ID 无效')

    const snapshot = await kv.get(ARTWORK_HISTORY_KEY)
    const history = arrayValue(snapshot) ?? []
    let updated = false
    const nextHistory = history.map(item => {
      if (recordId(item) !== targetId) return item
      const source = record(item)
      if (!source) return item
      updated = true
      return { ...source, ...patch }
    })
    if (!updated) return { updated: false }

    try {
      await kv.set(ARTWORK_HISTORY_KEY, nextHistory)
      return { updated: true }
    } catch (error) {
      await callSafely(() => kv.set(ARTWORK_HISTORY_KEY, snapshot), [])
      throw error
    }
  }

  function patchArtwork(id: string | number, patch: Record<string, unknown>): Promise<{ updated: boolean }> {
    const snapshot = structuredClone(patch)
    return enqueue(() => patchArtworkNow(id, snapshot))
  }

  function patchArtworks(patches: Array<{ id: string | number; patch: Record<string, unknown> }>): Promise<void> {
    const snapshots = structuredClone(patches)
    return enqueue(async () => {
      const history = arrayValue(await kv.get(ARTWORK_HISTORY_KEY)) ?? []
      const byId = new Map(snapshots.map(item => [comparableId(item.id), item.patch]))
      if ([...byId.keys()].some(id => !history.some(item => recordId(item) === id))) throw new Error('部分作品已不在作品册')
      const next = history.map(item => { const patch = byId.get(recordId(item)); return patch ? { ...record(item), ...patch } : item })
      await kv.set(ARTWORK_HISTORY_KEY, next)
    })
  }

  function appendArtwork(entry: ArtworkRecord): Promise<void> {
    const snapshot = structuredClone(entry)
    return enqueue(async () => {
      const history = arrayValue(await kv.get(ARTWORK_HISTORY_KEY)) ?? []
      if (history.some(item => recordId(item) === comparableId(snapshot.id))) throw new Error('作品编号已存在')
      const next = [...history, snapshot]
      await kv.set(ARTWORK_HISTORY_KEY, next)
    })
  }

  const reads = createArtworkReads(kv, withArtworkMutation)
  const media = createArtworkMedia(kv, images)
  let organization: Promise<ReturnType<typeof createArtworkOrganization>> | undefined
  function loadOrganization() {
    // Both public methods already own enqueue below; keep one undo authority,
    // and do not recursively acquire its library lock after loading.
    return organization ??= import('./artworkOrganization.ts')
      .then(({ createArtworkOrganization }) => createArtworkOrganization({ kv, enqueue: work => work() }))
      .catch(error => { organization = undefined; throw error })
  }
  let projects: Promise<ReturnType<typeof createArtworkProjects>> | undefined
  function loadProjects() {
    // Admission precedes loading; the caller already owns the same library lock.
    return projects ??= import('./artworkProjects.ts')
      .then(({ createArtworkProjects }) => createArtworkProjects(kv, work => work()))
      .catch(error => { projects = undefined; throw error })
  }
  return { ...reads, ...media, withStaging: withArtworkStaging, patchArtwork, patchArtworks, appendArtwork,
    createProject: async input => {
      const snapshot = structuredClone(input)
      return enqueue(async () => (await loadProjects()).createProject(snapshot))
    },
    saveSmartAlbum: async input => {
      const snapshot = structuredClone(input)
      return enqueue(async () => (await loadProjects()).saveSmartAlbum(snapshot))
    },
    deleteSmartAlbum: id => enqueue(async () => (await loadProjects()).deleteSmartAlbum(id)),
    organizeArtworks: async input => {
      const snapshot = structuredClone(input)
      return enqueue(async () => (await loadOrganization()).organizeArtworks(snapshot))
    },
    undoArtworkOrganization: async receipt => {
      const snapshot = structuredClone(receipt)
      return enqueue(async () => (await loadOrganization()).undoArtworkOrganization(snapshot))
    },
    resolveArtworkImport: (input, command, access) => {
      const snapshot = structuredClone(input), action = { ...command }
      return import('./artworkImport.ts').then(({ importWebArtwork }) => {
        access.check()
        return enqueue(() => importWebArtwork(snapshot, action, access))
      })
    },
    softDeleteArtwork, softDeleteArtworks, restoreArtwork, restoreArtworks, purgeExpiredTrash, purgeTrash, listTrash: listTrashNow }
}
