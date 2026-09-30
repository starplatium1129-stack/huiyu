import { defineComponent, h, KeepAlive, nextTick, reactive, ref } from 'vue'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
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
const wrappers: VueWrapper[] = []
function setup() {
  const context = {
    trashMode: ref(true), trashItems: ref<TrashEntry[]>([]), trashThumbs: reactive<Record<string, string>>({}),
    trashBusy: ref<string | number | null>(null), showToast: vi.fn(), loadGalleryStorage: vi.fn(async () => {}),
  }
  let actions!: ReturnType<typeof useGalleryTrash>
  const active = ref(true)
  const Gallery = defineComponent({ setup() {
    actions = useGalleryTrash(context)
    return () => h('div')
  } })
  const wrapper = mount(defineComponent({ setup: () => () => h(KeepAlive, null, { default: () => active.value ? h(Gallery) : null }) }))
  wrappers.push(wrapper)
  return { ...context, ...actions,
    async hide() { active.value = false; await nextTick() },
    async show() { active.value = true; await flushPromises() },
    unmount() { wrapper.unmount() },
  }
}
beforeEach(() => {
  repo.listTrash.mockReset().mockResolvedValue([])
  repo.getThumbnail.mockReset().mockImplementation(async (id: string) => `thumb:${id}`)
  repo.restoreArtwork.mockReset().mockResolvedValue({ restored: true })
})
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); vi.restoreAllMocks() })

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


it.each(['deactivate', 'unmount', 'wall'] as const)('rejects a pending trash list after %s without starting thumbnail reads', async (leave) => {
  const list = deferred<TrashEntry[]>()
  repo.listTrash.mockReturnValueOnce(list.promise)
  const gallery = setup()
  const pending = gallery.loadTrash()
  if (leave === 'deactivate') await gallery.hide()
  else if (leave === 'unmount') gallery.unmount()
  else gallery.trashMode.value = false
  list.resolve([entry('hidden')])
  await pending
  expect(gallery.trashItems.value).toEqual([])
  expect(repo.getThumbnail).not.toHaveBeenCalled()
  await gallery.loadTrash()
  expect(repo.listTrash).toHaveBeenCalledTimes(1)
})

it.each(['deactivate', 'unmount', 'wall'] as const)('stops the remaining trash thumbnail queue after %s', async (leave) => {
  const thumb = deferred<string>()
  repo.listTrash.mockResolvedValueOnce([entry('first', 2), entry('remaining')])
  repo.getThumbnail.mockReturnValueOnce(thumb.promise)
  const gallery = setup()
  const pending = gallery.loadTrash()
  await Promise.resolve()
  expect(repo.getThumbnail).toHaveBeenCalledExactlyOnceWith('image-first')
  if (leave === 'deactivate') await gallery.hide()
  else if (leave === 'unmount') gallery.unmount()
  else gallery.trashMode.value = false
  thumb.resolve('hidden-thumbnail')
  await pending
  expect(gallery.trashThumbs).toEqual({})
  expect(repo.getThumbnail).toHaveBeenCalledTimes(1)
})

it('reloads visible trash on KeepAlive return and rejects the pre-leave list', async () => {
  const old = deferred<TrashEntry[]>()
  repo.listTrash.mockReturnValueOnce(old.promise).mockResolvedValueOnce([entry('returned')])
  const gallery = setup()
  const pending = gallery.loadTrash()
  await gallery.hide()
  await gallery.show()
  old.resolve([entry('old')])
  await pending
  expect(gallery.trashItems.value.map(item => item.id)).toEqual(['returned'])
  expect(gallery.trashThumbs.returned).toBe('thumb:image-returned')
  expect(repo.getThumbnail).toHaveBeenCalledExactlyOnceWith('image-returned')
})

it('does not load hidden trash on return and allows opening trash again', async () => {
  const gallery = setup()
  gallery.trashMode.value = false
  await gallery.hide()
  await gallery.show()
  expect(repo.listTrash).not.toHaveBeenCalled()
  gallery.trashMode.value = true
  repo.listTrash.mockResolvedValueOnce([entry('reopened')])
  await gallery.loadTrash()
  expect(gallery.trashThumbs.reopened).toBe('thumb:image-reopened')
})

it('keeps an accepted restore owned across leaving and returning until it settles', async () => {
  const restored = deferred<{ restored: boolean }>()
  repo.restoreArtwork.mockReturnValueOnce(restored.promise)
  repo.listTrash.mockResolvedValue([entry('restored'), entry('remaining')])
  const gallery = setup()
  const pending = gallery.restoreTrashItem('restored')
  await gallery.hide()
  expect(gallery.trashBusy.value).toBe('restored')
  await gallery.show()
  await gallery.restoreTrashItem('remaining')
  expect(repo.restoreArtwork).toHaveBeenCalledTimes(1)
  restored.resolve({ restored: true })
  await pending
  expect(gallery.trashBusy.value).toBeNull()
  expect(gallery.trashItems.value.map(item => item.id)).toEqual(['remaining'])
  expect(gallery.trashThumbs).not.toHaveProperty('restored')
  expect(gallery.loadGalleryStorage).toHaveBeenCalledOnce()
  await gallery.restoreTrashItem('remaining')
  expect(repo.restoreArtwork).toHaveBeenCalledTimes(2)
  expect(gallery.trashBusy.value).toBeNull()
})

it.each(['deactivate', 'unmount'] as const)('settles unsuccessful restoration after %s without launching a hidden trash reload', async (leave) => {
  const restored = deferred<{ restored: boolean }>()
  repo.restoreArtwork.mockReturnValueOnce(restored.promise)
  const gallery = setup()
  const pending = gallery.restoreTrashItem('missing')
  if (leave === 'deactivate') await gallery.hide()
  else gallery.unmount()
  expect(gallery.trashBusy.value).toBe('missing')
  restored.resolve({ restored: false })
  await pending
  expect(gallery.trashBusy.value).toBeNull()
  expect(repo.listTrash).not.toHaveBeenCalled()
})


it.each(['deactivate', 'unmount'] as const)('completes an accepted successful restore after %s and clears its busy state', async (leave) => {
  const restored = deferred<{ restored: boolean }>()
  repo.restoreArtwork.mockReturnValueOnce(restored.promise)
  const gallery = setup()
  gallery.trashItems.value = [entry('restored')]
  const pending = gallery.restoreTrashItem('restored')
  if (leave === 'deactivate') await gallery.hide()
  else gallery.unmount()
  expect(gallery.trashBusy.value).toBe('restored')
  restored.resolve({ restored: true })
  await pending
  expect(gallery.trashBusy.value).toBeNull()
  expect(gallery.trashItems.value).toEqual([])
  expect(gallery.loadGalleryStorage).toHaveBeenCalledOnce()
  expect(repo.restoreArtwork).toHaveBeenCalledExactlyOnceWith('restored')
})

it('resumes incomplete thumbnail hydration on return without publishing an older in-flight thumbnail', async () => {
  const old = deferred<string>()
  repo.listTrash.mockResolvedValue([entry('first', 2), entry('remaining')])
  repo.getThumbnail.mockReturnValueOnce(old.promise)
  const gallery = setup()
  const pending = gallery.loadTrash()
  await Promise.resolve()
  await gallery.hide()
  await gallery.show()
  old.resolve('old-thumbnail')
  await pending
  expect(gallery.trashThumbs).toEqual({ first: 'thumb:image-first', remaining: 'thumb:image-remaining' })
  expect(repo.getThumbnail.mock.calls.map(([id]) => id)).toEqual(['image-first', 'image-first', 'image-remaining'])
})
