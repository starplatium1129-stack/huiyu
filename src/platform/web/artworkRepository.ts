import { kvGet, kvSet, kvSetMany } from '../../composables/useKVStore.ts'
import { withArtworkMutation } from '../../storage/artworkMutation.ts'
import { withArtworkCleanup, withArtworkStaging } from '../../storage/artworkSession.ts'
import { collectImageReferences, readLocalImageReferences, readSessionImageReferences } from '../../utils/storageReferences.ts'
import { imgDeleteMany, imgGetRecord, imgPutRecord } from '../../composables/useImageStore.ts'
import { thumbKey } from '../../utils/imageThumb.ts'
import { ARTWORK_HISTORY_QUARANTINE_KEY } from '../../utils/storageKeys.ts'
import { parseArtworkRecords, type ArtworkRecord } from '../../types/artwork.ts'
import type { ArtworkRepository, ArtworkDeleteResult, TrashEntry } from '../../application/artwork/artworkRepository.ts'
import { type ArtworkKvAdapter, type ArtworkImageAdapter, type WebArtworkRepositoryDependencies, ARTWORK_HISTORY_KEY, ARTWORK_PROJECTS_KEY, ARTWORK_TRASH_KEY, ARTWORK_TRASH_RETENTION_DAYS, record, comparableId, recordId, imageId, unique, arrayValue, removeProjectReferences, callSafely, ArtworkDeletionError } from './artworkStorage.ts'
import { createArtworkHardDelete } from './artworkHardDelete.ts'
import { createArtworkReads } from './artworkReads.ts'
import { createArtworkMedia } from './artworkMedia.ts'
export { ARTWORK_HISTORY_KEY, ARTWORK_PROJECTS_KEY, ARTWORK_TRASH_KEY, ARTWORK_TRASH_RETENTION_DAYS, ArtworkDeletionError } from './artworkStorage.ts'

export function createWebArtworkRepository(dependencies: WebArtworkRepositoryDependencies = {}): ArtworkRepository {
  const kv: ArtworkKvAdapter = {
    get: dependencies.kv?.get ?? (key => kvGet(key)),
    set: dependencies.kv?.set ?? ((key, value) => kvSet(key, value)),
    setMany: dependencies.kv ? dependencies.kv.setMany : entries => kvSetMany(entries),
    remove: dependencies.kv?.remove ?? (key => (dependencies.kv?.set ?? kvSet)(key, null)),
  }
  const images: ArtworkImageAdapter = {
    get: dependencies.images?.get ?? (id => imgGetRecord(id)),
    putRecord: dependencies.images?.putRecord ?? (value => imgPutRecord(value)),
    deleteMany: dependencies.images?.deleteMany ?? (ids => imgDeleteMany(ids)),
  }

  // Adapters own their storage isolation; the browser library also serializes across tabs.
  let mutationTail: Promise<void> = Promise.resolve()
  function enqueue<T>(work: () => Promise<T>, cleanup = false): Promise<T> {
    const operation = mutationTail.then(() => dependencies.kv ? work() : cleanup ? withArtworkCleanup(work) : withArtworkMutation(work))
    mutationTail = operation.then(() => undefined, () => undefined)
    return operation
  }

  /** History, project references and trash form one recoverable operation. */
  async function commitRelatedRecords(entries: Array<{ key: string; value: unknown }>, operation: string): Promise<void> {
    if (kv.setMany) return kv.setMany(entries)
    // Custom adapters without transactions retain the same compensation contract.
    const snapshots = await Promise.all(entries.map(entry => kv.get(entry.key)))
    let attempted = 0
    try {
      for (const entry of entries) { attempted += 1; await kv.set(entry.key, entry.value) }
    } catch (error) {
      const rollbackErrors: unknown[] = []
      for (let index = attempted - 1; index >= 0; index -= 1) {
        const { key } = entries[index]
        await callSafely(async () => {
          if (snapshots[index] == null) await (kv.remove ? kv.remove(key) : kv.set(key, null))
          else await kv.set(key, snapshots[index])
        }, rollbackErrors)
      }
      throw new ArtworkDeletionError(error, rollbackErrors, operation)
    }
  }

  const deleteArtworkNow = createArtworkHardDelete(kv, images)
  function deleteArtwork(id: string | number): Promise<ArtworkDeleteResult> {
    return enqueue(() => deleteArtworkNow(id))
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

  async function writeTrash(entries: TrashEntry[]): Promise<void> {
    await kv.set(ARTWORK_TRASH_KEY, entries)
  }

  async function softDeleteArtworkNow(id: string | number): Promise<{ deleted: boolean }> {
    const targetId = comparableId(id)
    if (!targetId) throw new Error('作品 ID 无效')

    const [historySnapshot, projectsSnapshot] = await Promise.all([
      kv.get(ARTWORK_HISTORY_KEY),
      kv.get(ARTWORK_PROJECTS_KEY),
    ])
    const history = arrayValue(historySnapshot) ?? []
    const targetEntries = history.filter(item => recordId(item) === targetId)
    if (!targetEntries.length) {
      // history 里没有：可能已被彻底删除，也可能是恢复竞态——都不重复入站
      return { deleted: false }
    }
    const nextHistory = history.filter(item => recordId(item) !== targetId)
    const projectUpdate = removeProjectReferences(projectsSnapshot, targetId)

    // 记录删除前的引用关系（恢复时只补回「快照有而现在没有」的引用）
    const projects = arrayValue(projectsSnapshot) ?? []
    const projectRefs = projects.map(project => {
      const source = record(project)
      return {
        projectId: source?.id ?? null,
        hadReference: Boolean(source && Array.isArray(source.history_ids)
          && source.history_ids.some(ref => comparableId(ref) === targetId)),
      }
    })

    const targetImageIds = unique(targetEntries.map(imageId))
    const remainingImageIds = new Set(unique(nextHistory.map(imageId)))
    const ownedImageIds = targetImageIds.filter(image => !remainingImageIds.has(image))

    const trash = await readTrash()
    // 同 id 重复软删（删除后没恢复又删一次的竞态）：后删的覆盖
    const nextTrash = trash.filter(entry => entry.id !== targetId)
    nextTrash.push({
      id: targetId,
      deletedAt: Date.now(),
      historyEntries: targetEntries,
      projectRefs,
      imageIds: ownedImageIds,
    })

    await commitRelatedRecords([
      { key: ARTWORK_HISTORY_KEY, value: nextHistory },
      ...(projectUpdate.changed ? [{ key: ARTWORK_PROJECTS_KEY, value: projectUpdate.value }] : []),
      { key: ARTWORK_TRASH_KEY, value: nextTrash },
    ], '作品删除')
    return { deleted: true }
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
    const requiredImageIds = unique([
      ...(Array.isArray(entry.imageIds) ? entry.imageIds : []),
      ...(Array.isArray(entry.historyEntries) ? entry.historyEntries.map(imageId) : []),
    ])
    const missingImageIds: string[] = []
    if (images.get) {
      for (const image of requiredImageIds) {
        if (!(await images.get(image))) missingImageIds.push(image)
      }
    }
    if (missingImageIds.length) return { restored: false, missingImageIds }
    // 同 id 已存在（恢复过一次的重复点击）：幂等成功
    const exists = history.some(item => recordId(item) === targetId)

    // 项目引用增量补回：只把「快照里有引用、现在没有」的 project 加回该 id，
    // 不整体回写旧快照——恢复期间新建/修改过的 project 不受影响。
    const projects = arrayValue(projectsSnapshot) ?? []
    let refsRestored = 0
    const nextProjects = projects.map(project => {
      const source = record(project)
      const ref = entry.projectRefs.find(r => comparableId(r.projectId) === comparableId(source?.id))
      if (!source || !ref || !ref.hadReference) return project
      if (!Array.isArray(source.history_ids)) return project
      if (source.history_ids.some(x => comparableId(x) === targetId)) return project
      refsRestored += 1
      return { ...source, history_ids: [...source.history_ids, targetId] }
    })
    await commitRelatedRecords([
      ...(!exists ? [{ key: ARTWORK_HISTORY_KEY, value: [...entry.historyEntries, ...history] }] : []),
      ...(refsRestored > 0 ? [{ key: ARTWORK_PROJECTS_KEY, value: nextProjects }] : []),
      { key: ARTWORK_TRASH_KEY, value: trash.filter(item => item.id !== targetId) },
    ], '作品恢复')
    return { restored: true }
  }

  /**
   * 懒清理：真删超期软删条目的图片与缩略图。只删「当前 history 无人引用」
   * 的 image。当前作品和仍未过期的 trash 快照都会保护其 historyEntries 与
   * imageIds 引用；恢复过的条目正常已移出 trash，这里仍保持防御性兜底。
   */
  async function purgeExpiredTrashNow(): Promise<{ purged: number }> {
    const trash = await readTrash()
    if (!trash.length) return { purged: 0 }
    const deadline = Date.now() - ARTWORK_TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000
    // 刚好到保留期限仍可恢复；非法时间戳保守地保留，避免清理误删快照。
    const expired = trash.filter(entry => {
      const deletedAt = Number(entry.deletedAt)
      return Number.isFinite(deletedAt) && deletedAt < deadline
    })
    if (!expired.length) return { purged: 0 }

    const [history, projects, quarantine] = await Promise.all([
      kv.get(ARTWORK_HISTORY_KEY), kv.get(ARTWORK_PROJECTS_KEY), kv.get(ARTWORK_HISTORY_QUARANTINE_KEY),
    ])
    const expiredIds = new Set(expired.map(entry => entry.id))
    const survivingTrash = trash.filter(entry => !expiredIds.has(entry.id))
    // imageIds 只是软删当时的“独占”快照，不能代替可恢复 historyEntries
    // 的引用；两者都要保护，才能覆盖共享图在多个墓碑间转移的时序。
    const entryImageIds = (entry: TrashEntry) => unique([
      ...(Array.isArray(entry.imageIds) ? entry.imageIds : []),
      ...(Array.isArray(entry.historyEntries) ? entry.historyEntries.map(imageId) : []),
    ])
    const protectedImageIds = collectImageReferences([
      history, projects, quarantine, survivingTrash,
      // Injected adapters own their environment; only the actual browser reads
      // browser drafts. Cleanup holds the document lease before the library lock.
      ...(dependencies.kv ? [] : [...readLocalImageReferences(localStorage), ...readSessionImageReferences(sessionStorage)]),
    ])
    const expiredImageIds = unique(expired.flatMap(entryImageIds))
    const removable = expiredImageIds.filter(image => !protectedImageIds.has(image))
    if (removable.length) {
      await images.deleteMany(removable)
      for (const image of removable) await kv.remove?.(thumbKey(image))
    }
    await writeTrash(survivingTrash)
    return { purged: expired.length }
  }

  function softDeleteArtwork(id: string | number): Promise<{ deleted: boolean }> {
    return enqueue(() => softDeleteArtworkNow(id))
  }

  function restoreArtwork(id: string | number): Promise<{ restored: boolean; missingImageIds?: string[] }> {
    return enqueue(() => restoreArtworkNow(id))
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

  function appendArtwork(entry: ArtworkRecord): Promise<ArtworkRecord[]> {
    const snapshot = structuredClone(entry)
    return enqueue(async () => {
      const history = arrayValue(await kv.get(ARTWORK_HISTORY_KEY)) ?? []
      if (history.some(item => recordId(item) === comparableId(snapshot.id))) throw new Error('作品编号已存在')
      const next = [...history, snapshot]
      await kv.set(ARTWORK_HISTORY_KEY, next)
      return structuredClone(parseArtworkRecords(next))
    })
  }

  const reads = createArtworkReads(kv, dependencies, work => dependencies.kv ? work() : withArtworkMutation(work))
  const media = createArtworkMedia(kv, images, dependencies)
  return { ...reads, ...media, withStaging: withArtworkStaging, deleteArtwork, patchArtwork, patchArtworks, appendArtwork, softDeleteArtwork, restoreArtwork, purgeExpiredTrash, listTrash: listTrashNow }
}
