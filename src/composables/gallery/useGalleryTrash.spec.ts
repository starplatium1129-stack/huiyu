import { reactive, ref } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { TrashEntry } from '@/storage/artworkRepository'
import { useGalleryTrash } from './useGalleryTrash'

const repo = vi.hoisted(() => ({ listTrash: vi.fn(), getThumbnail: vi.fn(), restoreArtwork: vi.fn() }))
vi.mock('@/storage/artworkRepository', () => ({ artworkRepository: repo }))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const entry = (id: string, deletedAt = 1): TrashEntry => ({ id, deletedAt, historyEntries: [], projectRefs: [], imageIds: [`image-${id}`] })
function setup() {
  const context = {
    trashItems: ref<TrashEntry[]>([]), trashThumbs: reactive<Record<string, string>>({}),
    trashBusy: ref<string | number | null>(null), showToast: vi.fn(), loadGalleryStorage: vi.fn(async () => {}),
  }
  return { ...context, ...useGalleryTrash(context) }
}
beforeEach(() => {
  repo.listTrash.mockReset().mockResolvedValue([])
  repo.getThumbnail.mockReset().mockImplementation(async (id: string) => `thumb:${id}`)
  repo.restoreArtwork.mockReset().mockResolvedValue({ restored: true })
})
afterEach(() => vi.restoreAllMocks())

it('ignores an older list that finishes after a newer load', async () => {
  const old = deferred<TrashEntry[]>()
  repo.listTrash.mockReturnValueOnce(old.promise).mockResolvedValueOnce([entry('new', 2), entry('newest', 3)])
  const gallery = setup()
  const pending = gallery.loadTrash()
  await gallery.loadTrash()
  old.resolve([entry('old')])
  await pending
  expect(gallery.trashItems.value.map(item => item.id)).toEqual(['newest', 'new'])
  expect(repo.getThumbnail.mock.calls.map(([id]) => id)).toEqual(['image-newest', 'image-new'])
  expect(gallery.trashThumbs).not.toHaveProperty('old')
})

it('does not let an obsolete thumbnail overwrite a newer load or continue old reads', async () => {
  const old = deferred<string>()
  repo.listTrash.mockResolvedValueOnce([entry('same', 2), entry('obsolete', 1)])
    .mockResolvedValueOnce([{ ...entry('same'), imageIds: ['new-image'] }])
  repo.getThumbnail.mockReturnValueOnce(old.promise)
  const gallery = setup()
  const pending = gallery.loadTrash()
  await Promise.resolve()
  expect(repo.getThumbnail).toHaveBeenCalledExactlyOnceWith('image-same')
  await gallery.loadTrash()
  old.resolve('old-thumbnail')
  await pending
  expect(gallery.trashThumbs.same).toBe('thumb:new-image')
  expect(repo.getThumbnail).not.toHaveBeenCalledWith('image-obsolete')
})

it('cannot reinsert a restored item from a list captured before restoration', async () => {
  const old = deferred<TrashEntry[]>()
  repo.listTrash.mockReturnValueOnce(old.promise)
  const gallery = setup()
  gallery.trashItems.value = [entry('restored')]
  gallery.trashThumbs.restored = 'existing-thumbnail'
  const pending = gallery.loadTrash()
  await gallery.restoreTrashItem('restored')
  old.resolve([entry('restored')])
  await pending
  expect(gallery.trashItems.value).toEqual([])
  expect(gallery.trashThumbs).not.toHaveProperty('restored')
  expect(repo.getThumbnail).not.toHaveBeenCalled()
  expect(gallery.loadGalleryStorage).toHaveBeenCalledOnce()
  expect(gallery.trashBusy.value).toBeNull()
  repo.listTrash.mockResolvedValueOnce([entry('later')])
  await gallery.loadTrash()
  expect(gallery.trashThumbs.later).toBe('thumb:image-later')
})

it('rejects a restored item thumbnail while still hydrating the remaining entries', async () => {
  const thumb = deferred<string>()
  repo.listTrash.mockResolvedValueOnce([entry('restored', 2), entry('remaining', 1)])
  repo.getThumbnail.mockReturnValueOnce(thumb.promise)
  const gallery = setup()
  const pending = gallery.loadTrash()
  await Promise.resolve()
  await gallery.restoreTrashItem('restored')
  thumb.resolve('late-thumbnail')
  await pending
  expect(gallery.trashItems.value.map(item => item.id)).toEqual(['remaining'])
  expect(gallery.trashThumbs).not.toHaveProperty('restored')
  expect(gallery.trashThumbs.remaining).toBe('thumb:image-remaining')
})

it('can retry a failed list without losing the displayed entries', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const gallery = setup()
  gallery.trashItems.value = [entry('existing')]
  repo.listTrash.mockRejectedValueOnce(new Error('temporarily unavailable'))
  await gallery.loadTrash()
  expect(gallery.trashItems.value.map(item => item.id)).toEqual(['existing'])
  repo.listTrash.mockResolvedValueOnce([entry('recovered')])
  await gallery.loadTrash()
  expect(gallery.trashItems.value.map(item => item.id)).toEqual(['recovered'])
  expect(gallery.trashThumbs.recovered).toBe('thumb:image-recovered')
})

it('a failed restoration does not invalidate a still-current list or leave restore busy', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const old = deferred<TrashEntry[]>()
  repo.listTrash.mockReturnValueOnce(old.promise)
  repo.restoreArtwork.mockRejectedValueOnce(new Error('temporarily unavailable'))
  const gallery = setup()
  const pending = gallery.loadTrash()
  await gallery.restoreTrashItem('still-trashed')
  old.resolve([entry('still-trashed')])
  await pending
  expect(gallery.trashItems.value.map(item => item.id)).toEqual(['still-trashed'])
  expect(gallery.trashThumbs['still-trashed']).toBe('thumb:image-still-trashed')
  expect(gallery.trashBusy.value).toBeNull()
  expect(gallery.loadGalleryStorage).not.toHaveBeenCalled()
})
