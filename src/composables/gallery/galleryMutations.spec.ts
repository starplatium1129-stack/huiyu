import { ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { bulkDeleteAction, toggleFavoriteAction } from './galleryMutations'
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

const context = () => ({ history: ref<ArtworkRecord[]>([]), showToast: vi.fn() })
const artwork = () => ({ id: 1, favorite: false } as ArtworkRecord)

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

describe('bulkDeleteAction', () => {
  it('取消确认时不触发删除与资源释放；确认后才真正软删、释放资源并弹出撤销提示', async () => {
    repo.softDeleteArtworks.mockResolvedValue([{ id: 10, deleted: true }, { id: 20, deleted: true }])

    const releaseCardResources = vi.fn()
    const loadGalleryStorage = vi.fn().mockResolvedValue(undefined)
    const showToast = vi.fn()
    const ctx: any = {
      showToast,
      viewerIndex: ref(-1),
      releaseCardResources,
      closeViewer: vi.fn(),
      bulkDeleting: ref(false),
      selectedIds: ref(new Set([10, 20])),
      loadGalleryStorage,
    }

    // 取消确认
    confirmActionMock.mockResolvedValueOnce(false)
    await bulkDeleteAction(ctx)
    expect(repo.softDeleteArtworks).not.toHaveBeenCalled()
    expect(releaseCardResources).not.toHaveBeenCalled()
    expect(ctx.selectedIds.value.size).toBe(2)

    // 确认删除
    confirmActionMock.mockResolvedValueOnce(true)
    await bulkDeleteAction(ctx)
    expect(repo.softDeleteArtworks).toHaveBeenCalledExactlyOnceWith([10, 20])
    expect(repo.softDeleteArtwork).not.toHaveBeenCalled()
    expect(releaseCardResources).toHaveBeenCalledWith(10)
    expect(releaseCardResources).toHaveBeenCalledWith(20)
    expect(loadGalleryStorage).toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('已移入回收站'), 'info', 6000, expect.any(Object))
  })

  it('uses bounded batches and retains only the unsuccessful selection', async () => {
    confirmActionMock.mockResolvedValue(true)
    repo.softDeleteArtworks.mockImplementation(async (ids: number[]) => ids.map(id => ({ id, deleted: id !== 201 })))
    const ctx: any = { showToast: vi.fn(), viewerIndex: ref(0), releaseCardResources: vi.fn(), closeViewer: vi.fn(),
      bulkDeleting: ref(false), selectedIds: ref(new Set(Array.from({ length: 401 }, (_, index) => index))), loadGalleryStorage: vi.fn() }
    await bulkDeleteAction(ctx)
    expect(repo.softDeleteArtworks.mock.calls.map(([ids]) => ids.length)).toEqual([200, 200, 1])
    expect(ctx.selectedIds.value).toEqual(new Set([201]))
    expect(ctx.releaseCardResources).toHaveBeenCalledTimes(400)
    expect(ctx.releaseCardResources).not.toHaveBeenCalledWith(201)
    expect(ctx.closeViewer).toHaveBeenCalledOnce()
    expect(ctx.loadGalleryStorage).toHaveBeenCalledOnce()
    expect(ctx.bulkDeleting.value).toBe(false)
  })

  it('reconciles the library after an unconfirmed batch instead of claiming nothing was deleted', async () => {
    confirmActionMock.mockResolvedValue(true)
    repo.softDeleteArtworks.mockRejectedValue(new Error('lost response'))
    const ctx: any = { showToast: vi.fn(), viewerIndex: ref(-1), releaseCardResources: vi.fn(), closeViewer: vi.fn(),
      bulkDeleting: ref(false), selectedIds: ref(new Set([10])), loadGalleryStorage: vi.fn() }
    await bulkDeleteAction(ctx)
    expect(ctx.loadGalleryStorage).toHaveBeenCalledOnce()
    expect(ctx.releaseCardResources).not.toHaveBeenCalled()
    expect(ctx.showToast).toHaveBeenCalledWith(expect.stringContaining('尚未确认'), 'warning', 5000)
  })
})
