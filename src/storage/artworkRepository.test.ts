/**
 * artworkRepository 单测（2026-08-31 七维审计 P1：补测试盲区）。
 *
 * 被测模块通过 WebArtworkRepositoryDependencies 注入 KV / 图片适配器，
 * 这里用内存 Map 假实现，不触 IndexedDB（useKVStore/useImageStore 均
 * 惰性访问，import 无副作用，无需 mock）。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  createWebArtworkRepository,
  ArtworkDeletionError,
  ARTWORK_TRASH_RETENTION_DAYS,
} from '../platform/web/artworkRepository'
import { thumbKey } from '../utils/imageThumb'
import type { StoredImageRecord } from '../composables/useImageStore'
import {
  ARTWORK_HISTORY_KV_KEY,
  ARTWORK_PROJECTS_KV_KEY,
  ARTWORK_TRASH_KV_KEY,
  ARTWORK_HISTORY_QUARANTINE_KEY,
} from '../utils/storageKeys'

const KV = {
  history: ARTWORK_HISTORY_KV_KEY,
  projects: ARTWORK_PROJECTS_KV_KEY,
  trash: ARTWORK_TRASH_KV_KEY,
}

function makeKv(initial: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(initial))
  const adapter = {
    get: vi.fn(async (key: string) => (store.has(key) ? store.get(key) : null)),
    set: vi.fn(async (key: string, value: unknown) => { store.set(key, value) }),
    remove: vi.fn(async (key: string) => { store.delete(key) }),
  }
  return { adapter, store }
}

function makeImages(initial: StoredImageRecord[] = []) {
  const store = new Map<string, StoredImageRecord>(initial.map(rec => [rec.id, rec]))
  const adapter = {
    get: vi.fn(async (id: string) => store.get(id) ?? null),
    putRecord: vi.fn(async (rec: { id: string; blob: Blob }) => {
      const full: StoredImageRecord = {
        id: rec.id, blob: rec.blob, name: '', type: '', size: 0, created_at: Date.now(),
      }
      store.set(rec.id, full)
      return rec.id
    }),
    deleteMany: vi.fn(async (ids: string[]) => { for (const id of ids) store.delete(id) }),
  }
  return { adapter, store }
}

const fakeBlob = new Blob(['x'], { type: 'image/png' })
const DAY = 24 * 60 * 60 * 1000

/** 组装一份「2 条历史 + 1 个项目引用其中一条」的仓库 */
function makeRepo() {
  const kv = makeKv()
  const images = makeImages([
    { id: 'img-a', blob: fakeBlob, name: 'a.png', type: 'image/png', size: 1, created_at: 1 },
    { id: 'img-b', blob: fakeBlob, name: 'b.png', type: 'image/png', size: 1, created_at: 2 },
  ])
  const history = [
    { id: 'a1', image_id: 'img-a', favorite: false },
    { id: 'b2', image_id: 'img-b', favorite: false },
  ]
  const projects = [{ id: 'p1', name: '项目一', history_ids: ['a1'] }]
  kv.store.set(KV.history, history)
  kv.store.set(KV.projects, projects)
  const repo = createWebArtworkRepository({ kv: kv.adapter, images: images.adapter })
  return { repo, kv, images }
}

function historyIds(kv: ReturnType<typeof makeKv>): string[] {
  return (kv.store.get(KV.history) as Array<{ id: string }>).map(h => h.id)
}

function makeTimedSharedRepo() {
  const epoch = 1_800_000_000_000
  const dateNow = vi.spyOn(Date, 'now').mockReturnValue(epoch)
  const kv = makeKv({
    [KV.history]: [
      { id: 'A', image_id: 'shared' },
      { id: 'B', image_id: 'shared' },
    ],
    [KV.projects]: [],
  })
  const images = makeImages([
    { id: 'shared', blob: fakeBlob, name: 'shared.png', type: 'image/png', size: 1, created_at: 1 },
  ])
  kv.store.set(thumbKey('shared'), { data: 'tiny' })
  const repo = createWebArtworkRepository({
    kv: kv.adapter,
    images: images.adapter,
  })
  return {
    repo,
    kv,
    images,
    setDay: (day: number) => { dateNow.mockReturnValue(epoch + day * DAY) },
    restoreClock: () => dateNow.mockRestore(),
  }
}

describe('artworkRepository 软删 / 恢复', () => {
  for (const operation of ['softDeleteArtwork', 'restoreArtwork'] as const) {
    for (const failureKey of [KV.history, KV.projects, KV.trash]) {
      it(`${operation}：${failureKey} 写入后失败也恢复完整快照，后续仍可重试`, async () => {
        const { repo, kv, images } = makeRepo()
        if (operation === 'restoreArtwork') await repo.softDeleteArtwork('a1')
        const before = new Map(kv.store)
        let failOnce = true
        kv.adapter.set.mockImplementation(async (key, value) => {
          kv.store.set(key, value)
          if (key === failureKey && failOnce) { failOnce = false; throw new Error('quota exceeded') }
        })

        await expect(repo[operation]('a1')).rejects.toMatchObject({ rollbackErrors: [] })
        expect(kv.store).toEqual(before)
        expect(images.adapter.deleteMany).not.toHaveBeenCalled()
        await expect(repo[operation]('a1')).resolves.toEqual(operation === 'softDeleteArtwork' ? { deleted: true } : { restored: true })
      })
    }
  }

  it('支持批量写的存储适配器在一个事务中提交删除和恢复的三个记录', async () => {
    const kv = makeKv({
      [KV.history]: [{ id: 'a1', image_id: 'img-a' }],
      [KV.projects]: [{ id: 'p1', history_ids: ['a1'] }],
    })
    const setMany = vi.fn(async (entries: Array<{ key: string; value: unknown }>) => {
      for (const entry of entries) kv.store.set(entry.key, entry.value)
    })
    const images = makeImages([
      { id: 'img-a', blob: fakeBlob, name: 'a.png', type: 'image/png', size: 1, created_at: 1 },
    ])
    const repo = createWebArtworkRepository({ kv: { ...kv.adapter, setMany }, images: images.adapter })
    await repo.softDeleteArtwork('a1')
    await repo.restoreArtwork('a1')
    expect(kv.adapter.set).not.toHaveBeenCalled()
    expect(setMany).toHaveBeenCalledTimes(2)
    for (const [entries] of setMany.mock.calls) {
      expect(entries.map(entry => entry.key)).toEqual([KV.history, KV.projects, KV.trash])
    }
    expect(kv.store.get(KV.history)).toEqual([{ id: 'a1', image_id: 'img-a' }])
    expect(kv.store.get(KV.trash)).toEqual([])
  })

  it('没有 remove 的适配器在同一存储内写 null 回滚新键', async () => {
    const history = [{ id: 'a1', image_id: 'img-a' }]
    const kv = makeKv({ [KV.history]: history })
    let failOnce = true
    kv.adapter.set.mockImplementation(async (key, value) => {
      kv.store.set(key, value)
      if (key === KV.trash && failOnce) { failOnce = false; throw new Error('quota') }
    })
    const repo = createWebArtworkRepository({ kv: { get: kv.adapter.get, set: kv.adapter.set } })
    await expect(repo.softDeleteArtwork('a1')).rejects.toMatchObject({ rollbackErrors: [] })
    expect(await kv.adapter.get(KV.trash)).toBeNull()
    expect(kv.store.get(KV.history)).toEqual(history)
    expect(kv.adapter.set).toHaveBeenCalledWith(KV.trash, null)
  })

  it('softDelete：history 移除、项目引用摘除、图片保留、快照进 trash', async () => {
    const { repo, kv, images } = makeRepo()
    const result = await repo.softDeleteArtwork('a1')

    expect(result.deleted).toBe(true)
    expect(historyIds(kv)).toEqual(['b2'])
    const projects = kv.store.get(KV.projects) as Array<{ history_ids: string[] }>
    expect(projects[0].history_ids).toEqual([])
    // 软删不真删图片
    expect(images.store.has('img-a')).toBe(true)
    expect(images.adapter.deleteMany).not.toHaveBeenCalled()

    const trash = kv.store.get(KV.trash) as Array<{ id: string; imageIds: string[]; historyEntries: unknown[] }>
    expect(trash).toHaveLength(1)
    expect(trash[0].id).toBe('a1')
    expect(trash[0].imageIds).toEqual(['img-a'])
    expect(trash[0].historyEntries).toHaveLength(1)
  })

  it('softDelete 不存在的 id：deleted=false 且不写 trash', async () => {
    const { repo, kv } = makeRepo()
    const result = await repo.softDeleteArtwork('ghost')
    expect(result.deleted).toBe(false)
    expect(kv.store.has(KV.trash)).toBe(false)
  })

  it('restore：history 条目与项目引用增量补回、trash 清空', async () => {
    const { repo, kv } = makeRepo()
    await repo.softDeleteArtwork('a1')
    const result = await repo.restoreArtwork('a1')

    expect(result.restored).toBe(true)
    expect(historyIds(kv)).toContain('a1')
    const projects = kv.store.get(KV.projects) as Array<{ history_ids: string[] }>
    expect(projects[0].history_ids).toEqual(['a1'])
    expect(kv.store.get(KV.trash)).toEqual([])
  })

  it('restore 不在 trash 的 id：restored=false', async () => {
    const { repo } = makeRepo()
    const result = await repo.restoreArtwork('never-deleted')
    expect(result.restored).toBe(false)
  })

  it('restore 原图缺失：保留 trash 且不报告完整恢复成功', async () => {
    const { repo, kv, images } = makeRepo()
    await repo.softDeleteArtwork('a1')
    images.store.delete('img-a')

    await expect(repo.restoreArtwork('a1')).resolves.toEqual({
      restored: false,
      missingImageIds: ['img-a'],
    })
    expect(kv.store.get(KV.trash)).toHaveLength(1)
    expect(historyIds(kv)).toEqual(['b2'])
  })

  it('同 id 重复软删：trash 只保留一条快照', async () => {
    const { repo, kv } = makeRepo()
    await repo.softDeleteArtwork('a1')
    await repo.restoreArtwork('a1')
    await repo.softDeleteArtwork('a1')
    const trash = kv.store.get(KV.trash) as unknown[]
    expect(trash).toHaveLength(1)
  })
})

describe('artworkRepository 惰性清理', () => {
  it('purge：完整共享引用时序在旧墓碑到期后仍可恢复新墓碑', async () => {
    const { repo, kv, images, setDay, restoreClock } = makeTimedSharedRepo()
    try {
      await repo.softDeleteArtwork('A')
      await repo.softDeleteArtwork('B')
      setDay(20)
      await expect(repo.restoreArtwork('A')).resolves.toEqual({ restored: true })
      await repo.softDeleteArtwork('A')

      setDay(31)
      expect(await repo.purgeExpiredTrash()).toEqual({ purged: 1 })
      expect(historyIds(kv)).toEqual([])
      expect(images.store.has('shared')).toBe(true)
      expect(kv.store.has(thumbKey('shared'))).toBe(true)
      expect((kv.store.get(KV.trash) as Array<{ id: string }>).map(item => item.id)).toEqual(['A'])

      await expect(repo.restoreArtwork('A')).resolves.toEqual({ restored: true })
      expect(historyIds(kv)).toEqual(['A'])
      expect(images.store.has('shared')).toBe(true)
    } finally {
      restoreClock()
    }
  })

  it('purge：到期边界仍保留，成功清理后重复执行无副作用', async () => {
    const epoch = 1_800_000_000_000
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(epoch)
    const kv = makeKv({
      [KV.history]: [],
      [KV.trash]: [{
        id: 'boundary',
        deletedAt: epoch,
        historyEntries: [{ id: 'boundary', image_id: 'img-boundary' }],
        projectRefs: [],
        imageIds: ['img-boundary'],
      }],
    })
    const images = makeImages([
      { id: 'img-boundary', blob: fakeBlob, name: 'boundary.png', type: 'image/png', size: 1, created_at: 1 },
    ])
    kv.store.set(thumbKey('img-boundary'), { data: 'tiny' })
    const repo = createWebArtworkRepository({ kv: kv.adapter, images: images.adapter })
    try {
      dateNow.mockReturnValue(epoch + ARTWORK_TRASH_RETENTION_DAYS * DAY)
      expect(await repo.purgeExpiredTrash()).toEqual({ purged: 0 })
      expect(images.store.has('img-boundary')).toBe(true)
      expect(kv.store.has(thumbKey('img-boundary'))).toBe(true)
      expect(kv.store.get(KV.trash)).toHaveLength(1)

      dateNow.mockReturnValue(epoch + (ARTWORK_TRASH_RETENTION_DAYS + 1) * DAY)
      expect(await repo.purgeExpiredTrash()).toEqual({ purged: 1 })
      expect(images.adapter.deleteMany).toHaveBeenCalledTimes(1)
      expect(await repo.purgeExpiredTrash()).toEqual({ purged: 0 })
      expect(images.adapter.deleteMany).toHaveBeenCalledTimes(1)
      expect(images.store.has('img-boundary')).toBe(false)
      expect(kv.store.has(thumbKey('img-boundary'))).toBe(false)
      expect(kv.store.get(KV.trash)).toEqual([])
    } finally {
      dateNow.mockRestore()
    }
  })

  it('purge：较新的 trash history 引用会保护共享原图与缩略图', async () => {
    const day = 24 * 60 * 60 * 1000
    const shared = { id: 'img-shared', blob: fakeBlob, name: 'shared.png', type: 'image/png', size: 1, created_at: 1 }
    const kv = makeKv({
      [KV.history]: [],
      [KV.trash]: [
        {
          id: 'old-trash', deletedAt: Date.now() - 31 * day,
          historyEntries: [{ id: 'old-trash', image_id: 'img-shared' }],
          projectRefs: [], imageIds: ['img-shared'],
        },
        {
          id: 'young-trash', deletedAt: Date.now() - 11 * day,
          historyEntries: [{ id: 'young-trash', image_id: 'img-shared' }],
          // 即使软删时的独占快照为空，恢复快照仍是合法引用来源。
          projectRefs: [], imageIds: [],
        },
      ],
    })
    const images = makeImages([shared])
    kv.store.set(thumbKey('img-shared'), { data: 'tiny' })
    const repo = createWebArtworkRepository({ kv: kv.adapter, images: images.adapter })

    expect(await repo.purgeExpiredTrash()).toEqual({ purged: 1 })
    expect(images.store.has('img-shared')).toBe(true)
    expect(kv.store.has(thumbKey('img-shared'))).toBe(true)
    expect((kv.store.get(KV.trash) as Array<{ id: string }>).map(item => item.id)).toEqual(['young-trash'])
  })

  it('purge：缩略图删除失败时保留墓碑并可重试', async () => {
    const { repo, kv, images } = makeRepo()
    await repo.softDeleteArtwork('a1')
    const day = 24 * 60 * 60 * 1000
    ;(kv.store.get(KV.trash) as Array<{ deletedAt: number }>)[0].deletedAt = Date.now() - 31 * day
    kv.store.set(thumbKey('img-a'), { data: 'tiny' })
    kv.adapter.remove.mockRejectedValueOnce(new Error('缩略图存储暂时不可用'))

    await expect(repo.purgeExpiredTrash()).rejects.toThrow('缩略图存储暂时不可用')
    expect(kv.store.get(KV.trash)).toHaveLength(1)
    expect(images.store.has('img-a')).toBe(false)
    expect(kv.store.has(thumbKey('img-a'))).toBe(true)

    await expect(repo.purgeExpiredTrash()).resolves.toEqual({ purged: 1 })
    expect(kv.store.get(KV.trash)).toEqual([])
    expect(kv.store.has(thumbKey('img-a'))).toBe(false)
  })

  it('purge：图片删除失败时保留 trash，下一次清理可重试', async () => {
    const { repo, kv, images } = makeRepo()
    await repo.softDeleteArtwork('a1')
    const day = 24 * 60 * 60 * 1000
    ;(kv.store.get(KV.trash) as Array<{ id: string; deletedAt: number }>)[0].deletedAt = Date.now() - 31 * day
    images.adapter.deleteMany.mockRejectedValueOnce(new Error('IDB 暂时不可用'))

    await expect(repo.purgeExpiredTrash()).rejects.toThrow('IDB 暂时不可用')
    expect(kv.store.get(KV.trash)).toHaveLength(1)
    expect(images.store.has('img-a')).toBe(true)
    await expect(repo.purgeExpiredTrash()).resolves.toEqual({ purged: 1 })
    expect(images.store.has('img-a')).toBe(false)
  })

  it('purge：只真删超期条目的独占图片，仍被引用的图片保留', async () => {
    const { repo, kv, images } = makeRepo()
    await repo.softDeleteArtwork('a1')
    await repo.softDeleteArtwork('b2')
    kv.store.set(thumbKey('img-b'), { data: 'tiny-b' })
    const day = 24 * 60 * 60 * 1000
    const trash = kv.store.get(KV.trash) as Array<{ id: string; deletedAt: number }>
    trash.find(t => t.id === 'a1')!.deletedAt = Date.now() - (ARTWORK_TRASH_RETENTION_DAYS + 1) * day

    // img-b 被人为加回 history（防御性兜底路径：条目超期也不删活图）
    ;(kv.store.get(KV.history) as unknown[]).push({ id: 'b2', image_id: 'img-b' })

    const result = await repo.purgeExpiredTrash()
    expect(result.purged).toBe(1)
    expect(images.store.has('img-a')).toBe(false)
    expect(images.store.has('img-b')).toBe(true)
    expect(kv.store.has(thumbKey('img-a'))).toBe(false)
    expect(kv.store.has(thumbKey('img-b'))).toBe(true)
    const rest = kv.store.get(KV.trash) as Array<{ id: string }>
    expect(rest.map(t => t.id)).toEqual(['b2'])
  })

  it('purge：trash 为空时返回 0 且不动图片', async () => {
    const { repo, images } = makeRepo()
    expect((await repo.purgeExpiredTrash()).purged).toBe(0)
    expect(images.adapter.deleteMany).not.toHaveBeenCalled()
  })
})

describe('artworkRepository 元数据补丁', () => {
  it('patchArtwork：就地更新标量字段（收藏/备注）', async () => {
    const { repo, kv } = makeRepo()
    const result = await repo.patchArtwork('b2', { favorite: true, notes: '神图' })
    expect(result.updated).toBe(true)
    const history = kv.store.get(KV.history) as Array<{ id: string; favorite: boolean; notes?: string }>
    expect(history.find(h => h.id === 'b2')).toMatchObject({ favorite: true, notes: '神图' })
  })

  it('patchArtwork：未知 id 返回 updated=false', async () => {
    const { repo } = makeRepo()
    expect((await repo.patchArtwork('ghost', { favorite: true })).updated).toBe(false)
  })
})

describe('artworkRepository 硬删与回滚', () => {
  it('deleteArtwork：history/图片/缩略图全部清除并返回清单', async () => {
    const { repo, kv, images } = makeRepo()
    kv.store.set(thumbKey('img-a'), { data: 'tiny' })
    const result = await repo.deleteArtwork('a1')

    expect(result.deleted).toBe(true)
    expect(result.removedImageIds).toEqual(['img-a'])
    expect(images.store.has('img-a')).toBe(false)
    expect(kv.store.has(thumbKey('img-a'))).toBe(false)
    expect(historyIds(kv)).toEqual(['b2'])
  })

  it('deleteArtwork：图片删除失败时补偿回滚 history 与项目引用', async () => {
    const { repo, kv, images } = makeRepo()
    const historySnapshot = kv.store.get(KV.history)
    const projectsSnapshot = kv.store.get(KV.projects)
    images.adapter.deleteMany.mockRejectedValueOnce(new Error('IDB 炸了'))

    await expect(repo.deleteArtwork('a1')).rejects.toBeInstanceOf(ArtworkDeletionError)
    // history 与项目引用回到删除前快照
    expect(kv.store.get(KV.history)).toEqual(historySnapshot)
    expect(kv.store.get(KV.projects)).toEqual(projectsSnapshot)
  })

  it('无效 id：直接抛错', async () => {
    const { repo } = makeRepo()
    await expect(repo.deleteArtwork('  ')).rejects.toThrow('作品 ID 无效')
  })
})

describe('artworkRepository 写串行化', () => {
  it('并发两个软删按序执行，两个条目都入 trash', async () => {
    const { repo, kv } = makeRepo()
    await Promise.all([repo.softDeleteArtwork('a1'), repo.softDeleteArtwork('b2')])
    const trash = kv.store.get(KV.trash) as Array<{ id: string }>
    expect(trash.map(t => t.id).sort()).toEqual(['a1', 'b2'])
    expect(historyIds(kv)).toEqual([])
  })
})


describe('expired trash protects all live reference domains', () => {
  it('keeps project and quarantine images while deleting only truly unreferenced candidates', async () => {
    const kv = makeKv({
      [KV.history]: [],
      [KV.projects]: [{ id: 'project', cover: { image_id: 'project-image' } }],
      [ARTWORK_HISTORY_QUARANTINE_KEY]: [{ image_id: 'quarantine-image' }],
      [KV.trash]: [{ id: 'expired', deletedAt: 1, historyEntries: [], projectRefs: [], imageIds: ['project-image', 'quarantine-image', 'orphan'] }],
    })
    const images = makeImages(['project-image', 'quarantine-image', 'orphan'].map(id => ({
      id, blob: fakeBlob, name: '', type: 'image/png', size: 1, created_at: 1,
    })))
    const repo = createWebArtworkRepository({ kv: kv.adapter, images: images.adapter })
    expect(await repo.purgeExpiredTrash()).toEqual({ purged: 1 })
    expect([...images.store.keys()]).toEqual(['project-image', 'quarantine-image'])
    expect(images.adapter.deleteMany).toHaveBeenCalledWith(['orphan'])
  })
})

describe('Web artwork reads and legacy imports', () => {
  it('filters invalid artwork records and detaches read/write snapshots without losing unknown fields', async () => {
    const kv = makeKv({ [KV.history]: [null, {}, { id: 2, extra: { detail: 'keep' } }] })
    const repo = createWebArtworkRepository({ kv: kv.adapter })
    const records = await repo.readHistory()
    expect(records).toEqual([{ id: 2, extra: { detail: 'keep' } }])
    ;(records[0].extra as { detail: string }).detail = 'changed'
    expect((await repo.readHistory())[0].extra).toEqual({ detail: 'keep' })
    const input = { id: 'new', extra: { detail: 'original' } }
    const saving = repo.appendArtwork(input)
    input.extra.detail = 'changed'
    const saved = await saving
    expect(saved[1]).toEqual({ id: 'new', extra: { detail: 'original' } })
    ;(saved[1].extra as { detail: string }).detail = 'changed again'
    expect((await repo.readHistory())[1].extra).toEqual({ detail: 'original' })
  })

  it('keeps an empty project list authoritative and reads the old key only when the new value is not an array', async () => {
    const kv = makeKv({ [KV.projects]: [], aics_projects: [{ id: 7, name: '旧项目', extra: { detail: 'keep' } }] })
    const repo = createWebArtworkRepository({ kv: kv.adapter })
    expect(await repo.readProjects()).toEqual([])
    expect(kv.adapter.get).not.toHaveBeenCalledWith('aics_projects')
    kv.store.delete(KV.projects)
    expect(await repo.readProjects()).toEqual([{ id: 7, name: '旧项目', extra: { detail: 'keep' } }])
  })

  it('failed library import retains its local source until the write succeeds', async () => {
    const kv = makeKv({ [KV.projects]: [] })
    const source = new Map([[KV.history, JSON.stringify([{ id: 'legacy', prompt: 'old work' }])]])
    const local = { getItem: (key: string) => source.get(key) ?? null, removeItem: (key: string) => { source.delete(key) } }
    const repo = createWebArtworkRepository({ kv: kv.adapter, localStorage: local })
    kv.adapter.set.mockRejectedValueOnce(new Error('quota'))
    await expect(repo.readLibrarySnapshot()).rejects.toThrow('quota')
    expect(source.get(KV.history)).toContain('legacy')
    expect(kv.store.has(KV.history)).toBe(false)
    expect((await repo.readLibrarySnapshot()).history).toEqual([{ id: 'legacy', prompt: 'old work' }])
    expect(source.has(KV.history)).toBe(false)
  })

  it('preserves Gallery empty-list authority, Home legacy import and read-only preference fallback', async () => {
    const kv = makeKv({ [KV.history]: [], [KV.projects]: [] })
    const local = { getItem: () => JSON.stringify([{ id: 'legacy', prompt: 'old work' }]), removeItem: vi.fn() }
    const repo = createWebArtworkRepository({ kv: kv.adapter, localStorage: local })
    expect((await repo.readLibrarySnapshot()).history).toEqual([])
    expect(await repo.readPreferenceHistory()).toEqual([])
    expect(kv.adapter.set).not.toHaveBeenCalled()
    expect(await repo.readRecentHistory()).toEqual([{ id: 'legacy', prompt: 'old work' }])
    expect(local.removeItem).toHaveBeenCalledWith(KV.history)
    kv.adapter.set.mockClear()
    kv.adapter.get.mockRejectedValueOnce(new Error('offline'))
    expect(await repo.readPreferenceHistory()).toEqual([{ id: 'legacy', prompt: 'old work' }])
    expect(kv.adapter.set).not.toHaveBeenCalled()
  })
})
