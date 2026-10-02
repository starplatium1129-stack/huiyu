import { computed, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bulkDeleteAction, confirmDeleteAction, toggleFavoriteAction } from './galleryMutations'
import type { ArtworkRecord } from '@/types/artwork'

const repo = vi.hoisted(() => ({
  patchArtwork: vi.fn(),
  softDeleteArtwork: vi.fn(),
  softDeleteArtworks: vi.fn(),
}))
const confirmActionMock = vi.hoisted(() => vi.fn())

vi.mock('@/storage/artworkRepository', () => ({ artworkRepository: repo }))
vi.mock('@/composables/useConfirm', () => ({ confirmAction: confirmActionMock }))

beforeEach(() => {
  repo.patchArtwork.mockReset()
  repo.softDeleteArtwork.mockReset()
  repo.softDeleteArtworks.mockReset()
  confirmActionMock.mockReset()
})
afterEach(() => vi.restoreAllMocks())

const context = () => ({ history: ref<ArtworkRecord[]>([]), showToast: vi.fn() })
const artwork = () => ({ id: 1, favorite: false } as ArtworkRecord)
const deleteContext = (ids: Array<string | number> = [1, 2]) => {
  const history = ref(ids.map(id => ({ id, favorite: false } as ArtworkRecord)))
  const visible = computed(() => history.value)
  return {
    history, visible, showToast: vi.fn(), deleting: ref(false), viewerIndex: ref(-1),
    indexOf: (item: ArtworkRecord) => visible.value.indexOf(item),
    releaseCardResources: vi.fn(), pendingDeleteId: ref<string | number | null>(ids[0] ?? null),
    closeViewer: vi.fn(), openViewer: vi.fn(), bulkDeleting: ref(false),
    selectedIds: ref(new Set(ids)), loadGalleryStorage: vi.fn().mockResolvedValue(undefined),
    onDeleted: vi.fn<(ids: Array<string | number>) => void>(),
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((success, failure) => { resolve = success; reject = failure })
  return { promise, resolve, reject }
}

it('rapid toggles serialize writes and preserve the latest click', async () => {
  let finish!: (value: { updated: boolean }) => void
  repo.patchArtwork.mockImplementationOnce(() => new Promise(resolve => { finish = resolve })).mockResolvedValue({ updated: true })
  const ctx = context(), item = artwork()
  const first = toggleFavoriteAction(ctx, item)
  const second = toggleFavoriteAction(ctx, item)
  await Promise.resolve()
  expect(item.favorite).toBe(false)
  expect(repo.patchArtwork).toHaveBeenCalledTimes(1)
  finish({ updated: true })
  await Promise.all([first, second])
  expect(repo.patchArtwork.mock.calls.map(call => call[1].favorite)).toEqual([true, false])
  expect(item.favorite).toBe(false)
})

it('a failed final write rolls back to the last confirmed value', async () => {
  repo.patchArtwork.mockResolvedValueOnce({ updated: true }).mockRejectedValueOnce(new Error('quota'))
  const ctx = context(), item = artwork()
  await Promise.all([toggleFavoriteAction(ctx, item), toggleFavoriteAction(ctx, item)])
  expect(item.favorite).toBe(true)
  expect(ctx.showToast).toHaveBeenCalledOnce()
  repo.patchArtwork.mockResolvedValue({ updated: true })
  await toggleFavoriteAction(ctx, item)
  expect(item.favorite).toBe(false)
})

it('an earlier failure cannot roll back a newer successful choice', async () => {
  repo.patchArtwork.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ updated: true })
  const ctx = context(), item = artwork()
  await Promise.all([toggleFavoriteAction(ctx, item), toggleFavoriteAction(ctx, item)])
  expect(item.favorite).toBe(false)
})

describe('confirmDeleteAction', () => {
  it('presents only confirmed deletion before removing the card or releasing its decoded image', async () => {
    const write = deferred<{ deleted: boolean }>()
    repo.softDeleteArtwork.mockReturnValue(write.promise)
    const ctx = deleteContext()
    const item = ctx.history.value[0]!
    const snapshots: Array<{ ids: Array<string | number>; history: Array<string | number>; released: number }> = []
    ctx.onDeleted.mockImplementation(ids => {
      snapshots.push({ ids, history: ctx.history.value.map(item => item.id), released: ctx.releaseCardResources.mock.calls.length })
    })
    ctx.releaseCardResources.mockImplementation(() => {
      expect(ctx.history.value.map(item => item.id)).toEqual([2])
      expect(ctx.onDeleted).toHaveBeenCalledOnce()
    })
    const deletion = confirmDeleteAction(ctx, item)
    expect(ctx.onDeleted).not.toHaveBeenCalled()
    expect(ctx.history.value.map(item => item.id)).toEqual([1, 2])
    expect(ctx.deleting.value).toBe(true)
    write.resolve({ deleted: true })
    await deletion
    expect(snapshots).toEqual([{ ids: [1], history: [1, 2], released: 0 }])
    expect(ctx.onDeleted).toHaveBeenCalledExactlyOnceWith([1])
    expect(ctx.releaseCardResources).toHaveBeenCalledExactlyOnceWith(1)
    expect(ctx.pendingDeleteId.value).toBeNull()
    expect(ctx.deleting.value).toBe(false)
    expect(ctx.showToast).toHaveBeenCalledWith(expect.stringContaining('已移入回收站'), 'info', 5000, expect.any(Object))
  })

  it.each(['missing', 'failed'] as const)('does not present a %s deletion or change history', async outcome => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const write = deferred<{ deleted: boolean }>()
    repo.softDeleteArtwork.mockReturnValue(write.promise)
    const ctx = deleteContext()
    const deletion = confirmDeleteAction(ctx, ctx.history.value[0]!)
    expect(ctx.onDeleted).not.toHaveBeenCalled()
    if (outcome === 'missing') write.resolve({ deleted: false })
    else write.reject(new Error('storage failure'))
    await deletion
    expect(ctx.onDeleted).not.toHaveBeenCalled()
    expect(ctx.releaseCardResources).not.toHaveBeenCalled()
    expect(ctx.history.value.map(item => item.id)).toEqual([1, 2])
    expect(ctx.pendingDeleteId.value).toBe(1)
    expect(ctx.deleting.value).toBe(false)
  })

  it('keeps a confirmed deletion successful if presentation throws', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    repo.softDeleteArtwork.mockResolvedValue({ deleted: true })
    const ctx = deleteContext()
    ctx.onDeleted.mockImplementation(() => { throw new Error('snapshot failed') })
    await confirmDeleteAction(ctx, ctx.history.value[0]!)
    expect(ctx.history.value.map(item => item.id)).toEqual([2])
    expect(ctx.releaseCardResources).toHaveBeenCalledExactlyOnceWith(1)
    expect(ctx.showToast).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('已移入回收站'), 'info', 5000, expect.any(Object))
    expect(ctx.deleting.value).toBe(false)
  })

})

describe('bulkDeleteAction', () => {
  it('locks the confirmation and deletes only its captured IDs while preserving newer selections', async () => {
    const approval = deferred<boolean>()
    confirmActionMock.mockReturnValueOnce(approval.promise)
    repo.softDeleteArtworks.mockResolvedValue([{ id: 10, deleted: true }, { id: 20, deleted: false }])
    const ctx = deleteContext([10, 20, 30])
    ctx.selectedIds.value = new Set([10, 20])
    const pending = bulkDeleteAction(ctx)
    expect(ctx.bulkDeleting.value).toBe(true)
    ctx.selectedIds.value = new Set([20, 30])
    await bulkDeleteAction(ctx)
    expect(confirmActionMock).toHaveBeenCalledOnce()
    approval.resolve(true)
    await pending
    expect(repo.softDeleteArtworks).toHaveBeenCalledExactlyOnceWith([10, 20])
    expect(ctx.onDeleted).toHaveBeenCalledExactlyOnceWith([10])
    expect(ctx.history.value.map(item => item.id)).toEqual([20, 30])
    expect(ctx.selectedIds.value).toEqual(new Set([20, 30]))
    expect(ctx.bulkDeleting.value).toBe(false)
  })

  it('finishes an accepted batch without closing a viewer from a newer visit', async () => {
    const write = deferred<Array<{ id: number; deleted: boolean }>>()
    repo.softDeleteArtworks.mockReturnValueOnce(write.promise)
    confirmActionMock.mockResolvedValueOnce(true)
    let current = true
    const ctx = { ...deleteContext([10, 20]), isCurrentView: () => current }
    const pending = bulkDeleteAction(ctx)
    await Promise.resolve()
    current = false
    ctx.viewerIndex.value = 0
    write.resolve([{ id: 10, deleted: true }, { id: 20, deleted: true }])
    await pending
    expect(ctx.history.value).toEqual([])
    expect(ctx.releaseCardResources).toHaveBeenCalledTimes(2)
    expect(ctx.closeViewer).not.toHaveBeenCalled()
    expect(ctx.onDeleted).not.toHaveBeenCalled()
    expect(ctx.loadGalleryStorage).toHaveBeenCalledOnce()
  })

  it('取消确认时不触发删除与资源释放；确认后才真正软删、释放资源并弹出撤销提示', async () => {
    repo.softDeleteArtworks.mockResolvedValue([{ id: 10, deleted: true }, { id: 20, deleted: true }])

    const ctx = deleteContext([10, 20])
    const { releaseCardResources, loadGalleryStorage, showToast } = ctx

    // 取消确认
    confirmActionMock.mockResolvedValueOnce(false)
    await bulkDeleteAction(ctx)
    expect(repo.softDeleteArtworks).not.toHaveBeenCalled()
    expect(releaseCardResources).not.toHaveBeenCalled()
    expect(ctx.onDeleted).not.toHaveBeenCalled()
    expect(ctx.selectedIds.value.size).toBe(2)

    // 确认删除
    confirmActionMock.mockResolvedValueOnce(true)
    await bulkDeleteAction(ctx)
    expect(repo.softDeleteArtworks).toHaveBeenCalledExactlyOnceWith([10, 20])
    expect(repo.softDeleteArtwork).not.toHaveBeenCalled()
    expect(releaseCardResources).toHaveBeenCalledWith(10)
    expect(releaseCardResources).toHaveBeenCalledWith(20)
    expect(loadGalleryStorage).toHaveBeenCalled()
    expect(ctx.onDeleted).toHaveBeenCalledExactlyOnceWith([10, 20])
    expect(ctx.history.value).toEqual([])
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('已移入回收站'), 'info', 6000, expect.any(Object))
  })

  it('uses bounded batches and retains only the unsuccessful selection', async () => {
    confirmActionMock.mockResolvedValue(true)
    repo.softDeleteArtworks.mockImplementation(async (ids: number[]) => ids.map(id => ({ id, deleted: id !== 201 })))
    const ctx = deleteContext(Array.from({ length: 401 }, (_, index) => index))
    ctx.viewerIndex.value = 0
    await bulkDeleteAction(ctx)
    expect(repo.softDeleteArtworks.mock.calls.map(([ids]) => ids.length)).toEqual([200, 200, 1])
    expect(ctx.selectedIds.value).toEqual(new Set([201]))
    expect(ctx.releaseCardResources).toHaveBeenCalledTimes(400)
    expect(ctx.releaseCardResources).not.toHaveBeenCalledWith(201)
    expect(ctx.closeViewer).toHaveBeenCalledOnce()
    expect(ctx.loadGalleryStorage).toHaveBeenCalledOnce()
    expect(ctx.bulkDeleting.value).toBe(false)
    expect(ctx.onDeleted).toHaveBeenCalledOnce()
    expect(ctx.onDeleted.mock.calls[0]![0]).not.toContain(201)
    expect(ctx.history.value.map(item => item.id)).toEqual([201])
  })

  it('reconciles the library after an unconfirmed batch instead of claiming nothing was deleted', async () => {
    confirmActionMock.mockResolvedValue(true)
    repo.softDeleteArtworks.mockRejectedValue(new Error('lost response'))
    const ctx = deleteContext([10])
    ctx.loadGalleryStorage.mockImplementation(async () => { ctx.history.value = [] })
    await bulkDeleteAction(ctx)
    expect(ctx.loadGalleryStorage).toHaveBeenCalledOnce()
    expect(ctx.releaseCardResources).not.toHaveBeenCalled()
    expect(ctx.onDeleted).not.toHaveBeenCalled()
    expect(ctx.history.value).toEqual([])
    expect(ctx.showToast).toHaveBeenCalledWith(expect.stringContaining('尚未确认'), 'warning', 5000)
  })

  it('waits for all batches, presents confirmed IDs once, then removes originals before release and reload', async () => {
    confirmActionMock.mockResolvedValue(true)
    type Results = Array<{ id: number; deleted: boolean }>
    const batches = [deferred<Results>(), deferred<Results>(), deferred<Results>()]
    repo.softDeleteArtworks.mockReturnValueOnce(batches[0]!.promise)
      .mockReturnValueOnce(batches[1]!.promise).mockReturnValueOnce(batches[2]!.promise)
    const ids = Array.from({ length: 401 }, (_, index) => index)
    const confirmed = [...ids.slice(0, 200).filter(id => id !== 3), 400]
    const failed = [3, ...ids.slice(200, 400)]
    const ctx = deleteContext(ids)
    const reload = deferred<void>()
    ctx.loadGalleryStorage.mockReturnValue(reload.promise)
    const snapshots: Array<{ ids: Array<string | number>; history: Array<string | number>; released: number; reloaded: number }> = []
    ctx.onDeleted.mockImplementation(deleted => {
      snapshots.push({ ids: deleted, history: ctx.history.value.map(item => item.id),
        released: ctx.releaseCardResources.mock.calls.length, reloaded: ctx.loadGalleryStorage.mock.calls.length })
    })
    ctx.releaseCardResources.mockImplementation(() => {
      expect(ctx.history.value.map(item => item.id)).toEqual(failed)
      expect(ctx.onDeleted).toHaveBeenCalledOnce()
    })

    const deletion = bulkDeleteAction(ctx)
    await Promise.resolve()
    expect(ctx.onDeleted).not.toHaveBeenCalled()
    batches[0]!.resolve(ids.slice(0, 200).map(id => ({ id, deleted: id !== 3 })))
    await Promise.resolve()
    expect(ctx.onDeleted).not.toHaveBeenCalled()
    expect(ctx.releaseCardResources).not.toHaveBeenCalled()
    batches[1]!.reject(new Error('lost response'))
    await Promise.resolve()
    expect(ctx.onDeleted).not.toHaveBeenCalled()
    batches[2]!.resolve([{ id: 400, deleted: true }])
    await Promise.resolve()
    expect(ctx.onDeleted).toHaveBeenCalledExactlyOnceWith(confirmed)
    expect(snapshots).toEqual([{ ids: confirmed, history: ids, released: 0, reloaded: 0 }])
    expect(ctx.history.value.map(item => item.id)).toEqual(failed)
    expect(ctx.releaseCardResources).toHaveBeenCalledTimes(confirmed.length)
    expect(ctx.loadGalleryStorage).toHaveBeenCalledOnce()
    expect(ctx.bulkDeleting.value).toBe(true)
    reload.resolve()
    await deletion
    expect(ctx.selectedIds.value).toEqual(new Set(failed))
    expect(ctx.bulkDeleting.value).toBe(false)
    expect(ctx.showToast).toHaveBeenCalledWith(expect.stringContaining('200 幅已移入回收站'), 'warning', 5000)
  })

  it('does not present any IDs when every result is missing', async () => {
    confirmActionMock.mockResolvedValue(true)
    repo.softDeleteArtworks.mockResolvedValue([{ id: 1, deleted: false }, { id: 2, deleted: false }])
    const ctx = deleteContext()
    await bulkDeleteAction(ctx)
    expect(ctx.onDeleted).not.toHaveBeenCalled()
    expect(ctx.releaseCardResources).not.toHaveBeenCalled()
    expect(ctx.history.value.map(item => item.id)).toEqual([1, 2])
    expect(ctx.selectedIds.value).toEqual(new Set([1, 2]))
  })

  it('preserves successful bulk cleanup, reload and undo when presentation throws', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    confirmActionMock.mockResolvedValue(true)
    repo.softDeleteArtworks.mockResolvedValue([{ id: 1, deleted: true }, { id: 2, deleted: true }])
    const ctx = deleteContext()
    ctx.onDeleted.mockImplementation(() => { throw new Error('snapshot failed') })
    await bulkDeleteAction(ctx)
    expect(ctx.history.value).toEqual([])
    expect(ctx.releaseCardResources).toHaveBeenCalledTimes(2)
    expect(ctx.selectedIds.value.size).toBe(0)
    expect(ctx.loadGalleryStorage).toHaveBeenCalledOnce()
    expect(ctx.showToast).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('2 幅已移入回收站'), 'info', 6000, expect.any(Object))
    expect(ctx.bulkDeleting.value).toBe(false)
  })
})
