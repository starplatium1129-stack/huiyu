import { kvGet, kvSet, kvSetMany } from '../composables/useKVStore.ts'
import { withArtworkMutation } from './artworkMutation.ts'
import {
  imgDeleteMany,
  imgGetRecord,
  imgPutRecord,
  type ImageRecordInput,
  type StoredImageRecord,
} from '../composables/useImageStore.ts'
import { thumbKey } from '../utils/imageThumb.ts'
import { ARTWORK_HISTORY_KV_KEY, ARTWORK_PROJECTS_KV_KEY, ARTWORK_TRASH_KV_KEY } from '../utils/storageKeys.ts'

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
  putRecord(record: ImageRecordInput): Promise<string>
  deleteMany(ids: string[]): Promise<void>
}

export interface ArtworkRepositoryDependencies {
  kv?: Partial<ArtworkKvAdapter>
  images?: Partial<ArtworkImageAdapter>
}

export interface ArtworkDeleteResult {
  deleted: boolean
  historyChanged: boolean
  removedImageIds: string[]
  removedThumbnailIds: string[]
  removedProjectReferences: number
}

/** 软删回收站条目（2026-08-30 UX 审计 P0-8）。快照只存恢复所需增量信息，不复制图片数据。 */
export interface TrashEntry {
  id: string
  deletedAt: number
  /** 被移除的 history 条目（原样保存，恢复时追加回去）。 */
  historyEntries: unknown[]
  /** 删除前每条 project 的 id 与是否引用该作品（恢复时增量补回引用）。 */
  projectRefs: Array<{ projectId: unknown; hadReference: boolean }>
  /** 该作品独占、purge 时应真删的 image id。 */
  imageIds: string[]
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

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function comparableId(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

function recordId(value: unknown): string | null {
  return comparableId(record(value)?.id)
}

function imageId(value: unknown): string | null {
  const id = record(value)?.image_id
  return typeof id === 'string' && id.trim() ? id.trim() : null
}

function unique(values: readonly (string | null)[]): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))]
}

function arrayValue(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value.slice() : null
}

function removeProjectReferences(value: unknown, targetId: string): {
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

function imageRecordInput(record: StoredImageRecord): ImageRecordInput {
  return {
    id: record.id,
    blob: record.blob,
    name: record.name,
    type: record.type,
    created_at: record.created_at,
  }
}

async function callSafely(action: () => Promise<void>, errors: unknown[]): Promise<void> {
  try { await action() } catch (error) { errors.push(error) }
}

export function createArtworkRepository(dependencies: ArtworkRepositoryDependencies = {}) {
  const kv: ArtworkKvAdapter = {
    get: dependencies.kv?.get ?? (key => kvGet(key)),
    set: dependencies.kv?.set ?? ((key, value) => kvSet(key, value)),
    setMany: dependencies.kv ? dependencies.kv.setMany : kvSetMany,
    remove: dependencies.kv?.remove ?? (key => (dependencies.kv?.set ?? kvSet)(key, null)),
  }
  const images: ArtworkImageAdapter = {
    get: dependencies.images?.get ?? (id => imgGetRecord(id)),
    putRecord: dependencies.images?.putRecord ?? (value => imgPutRecord(value)),
    deleteMany: dependencies.images?.deleteMany ?? (ids => imgDeleteMany(ids)),
  }

  // Adapters own their storage isolation; the browser library also serializes across tabs.
  let mutationTail: Promise<void> = Promise.resolve()
  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const operation = mutationTail.then(() => dependencies.kv ? work() : withArtworkMutation(work))
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

  async function deleteArtworkNow(id: string | number): Promise<ArtworkDeleteResult> {
    const targetId = comparableId(id)
    if (!targetId) throw new Error('作品 ID 无效')

    const [historySnapshot, projectsSnapshot] = await Promise.all([
      kv.get(ARTWORK_HISTORY_KEY),
      kv.get(ARTWORK_PROJECTS_KEY),
    ])
    const history = arrayValue(historySnapshot) ?? []
    const targetEntries = history.filter(item => recordId(item) === targetId)
    const nextHistory = history.filter(item => recordId(item) !== targetId)
    const historyChanged = targetEntries.length > 0
    const projectUpdate = removeProjectReferences(projectsSnapshot, targetId)

    const targetImageIds = unique(targetEntries.map(imageId))
    const remainingImageIds = new Set(unique(nextHistory.map(imageId)))
    const removedImageIds = targetImageIds.filter(image => !remainingImageIds.has(image))
    const removedThumbnailIds = removedImageIds.slice()

    if (!historyChanged && !projectUpdate.changed) {
      return {
        deleted: false,
        historyChanged: false,
        removedImageIds: [],
        removedThumbnailIds: [],
        removedProjectReferences: 0,
      }
    }

    const imageSnapshot = (await Promise.all(removedImageIds.map(image => images.get(image))))
      .filter((item): item is StoredImageRecord => item !== null)
    const thumbnailSnapshot = new Map<string, unknown>()
    for (const image of removedThumbnailIds) {
      thumbnailSnapshot.set(image, await kv.get(thumbKey(image)))
    }

    let historyWriteAttempted = false
    let projectWriteAttempted = false
    let imageDeleteAttempted = false
    let thumbnailDeleteAttempted = false

    try {
      if (historyChanged) {
        historyWriteAttempted = true
        await kv.set(ARTWORK_HISTORY_KEY, nextHistory)
      }
      if (projectUpdate.changed) {
        projectWriteAttempted = true
        await kv.set(ARTWORK_PROJECTS_KEY, projectUpdate.value)
      }
      if (removedImageIds.length) {
        imageDeleteAttempted = true
        await images.deleteMany(removedImageIds)
      }
      if (removedThumbnailIds.length) {
        thumbnailDeleteAttempted = true
        for (const image of removedThumbnailIds) await kv.remove?.(thumbKey(image))
      }
      return {
        deleted: historyChanged,
        historyChanged,
        removedImageIds,
        removedThumbnailIds,
        removedProjectReferences: projectUpdate.removed,
      }
    } catch (originalError) {
      const rollbackErrors: unknown[] = []
      if (imageDeleteAttempted) {
        for (const snapshot of imageSnapshot) {
          await callSafely(() => images.putRecord(imageRecordInput(snapshot)).then(() => undefined), rollbackErrors)
        }
      }
      if (thumbnailDeleteAttempted) {
        for (const [image, snapshot] of thumbnailSnapshot) {
          await callSafely(async () => {
            if (snapshot == null) await kv.remove?.(thumbKey(image))
            else await kv.set(thumbKey(image), snapshot)
          }, rollbackErrors)
        }
      }
      if (projectWriteAttempted) {
        await callSafely(() => kv.set(ARTWORK_PROJECTS_KEY, projectsSnapshot), rollbackErrors)
      }
      if (historyWriteAttempted) {
        await callSafely(() => kv.set(ARTWORK_HISTORY_KEY, historySnapshot), rollbackErrors)
      }
      throw new ArtworkDeletionError(originalError, rollbackErrors)
    }
  }

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

    const historySnapshot = await kv.get(ARTWORK_HISTORY_KEY)
    const history = arrayValue(historySnapshot) ?? []
    const expiredIds = new Set(expired.map(entry => entry.id))
    const survivingTrash = trash.filter(entry => !expiredIds.has(entry.id))
    // imageIds 只是软删当时的“独占”快照，不能代替可恢复 historyEntries
    // 的引用；两者都要保护，才能覆盖共享图在多个墓碑间转移的时序。
    const entryImageIds = (entry: TrashEntry) => unique([
      ...(Array.isArray(entry.imageIds) ? entry.imageIds : []),
      ...(Array.isArray(entry.historyEntries) ? entry.historyEntries.map(imageId) : []),
    ])
    const protectedImageIds = new Set([
      ...unique(history.map(imageId)),
      ...survivingTrash.flatMap(entryImageIds),
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
    return enqueue(() => purgeExpiredTrashNow())
  }

  /** 列出回收站全部软删条目（2026-08-31 回收站视图用，含删除时间与首图 id）。 */
  function listTrashNow(): Promise<TrashEntry[]> {
    return readTrash()
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
    return enqueue(() => patchArtworkNow(id, patch))
  }

  function patchArtworks(patches: Array<{ id: string | number; patch: Record<string, unknown> }>): Promise<void> {
    return enqueue(async () => {
      const history = arrayValue(await kv.get(ARTWORK_HISTORY_KEY)) ?? []
      const byId = new Map(patches.map(item => [comparableId(item.id), item.patch]))
      if ([...byId.keys()].some(id => !history.some(item => recordId(item) === id))) throw new Error('部分作品已不在作品册')
      const next = history.map(item => { const patch = byId.get(recordId(item)); return patch ? { ...record(item), ...patch } : item })
      await kv.set(ARTWORK_HISTORY_KEY, next)
    })
  }

  function appendArtwork<T extends { id: string | number }>(entry: T): Promise<T[]> {
    return enqueue(async () => {
      const history = arrayValue(await kv.get(ARTWORK_HISTORY_KEY)) ?? []
      if (history.some(item => recordId(item) === comparableId(entry.id))) throw new Error('作品编号已存在')
      const next = [...history, entry]
      await kv.set(ARTWORK_HISTORY_KEY, next)
      return next as T[]
    })
  }

  return { deleteArtwork, patchArtwork, patchArtworks, appendArtwork, softDeleteArtwork, restoreArtwork, purgeExpiredTrash, listTrash: listTrashNow }
}

export const artworkRepository = createArtworkRepository()

export async function deleteArtwork(id: string | number): Promise<ArtworkDeleteResult> {
  return artworkRepository.deleteArtwork(id)
}

/** 软删：可见性立即消失，图片保留 30 天，期间可 restoreArtwork 整条恢复。 */
export async function softDeleteArtwork(id: string | number): Promise<{ deleted: boolean }> {
  return artworkRepository.softDeleteArtwork(id)
}

/** 从回收站恢复一条软删作品（历史条目 + 项目引用增量补回）。 */
export async function restoreArtwork(id: string | number): Promise<{ restored: boolean; missingImageIds?: string[] }> {
  return artworkRepository.restoreArtwork(id)
}

/** 懒清理超期软删（作品册挂载时调一次）。返回真删条数。 */
export async function purgeExpiredTrash(): Promise<{ purged: number }> {
  return artworkRepository.purgeExpiredTrash()
}

/** 列出回收站全部软删条目（回收站视图）。 */
export async function listTrash(): Promise<TrashEntry[]> {
  return artworkRepository.listTrash()
}

/** 更新单条作品的元数据（收藏 / 备注 / 评分）。 */
export async function patchArtwork(
  id: string | number,
  patch: Record<string, unknown>,
): Promise<{ updated: boolean }> {
  return artworkRepository.patchArtwork(id, patch)
}
