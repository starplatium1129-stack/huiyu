import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { defineComponent, h, KeepAlive, nextTick, reactive, ref } from 'vue'
import { useRoute } from 'vue-router'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import type { ArtworkRecord } from '@/types/artwork'

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(), softDeleteArtworks: vi.fn(), listTrash: vi.fn(), restoreArtwork: vi.fn(), getImage: vi.fn(), getThumbnail: vi.fn(), setThumbnail: vi.fn(), snapshot: vi.fn(), thumb: vi.fn(),
  route: { path: '/gallery', query: {} }, replace: vi.fn(),
}))
vi.mock('@/storage/artworkRepository', () => ({ artworkRepository: {
  softDeleteArtworks: mocks.softDeleteArtworks, listTrash: mocks.listTrash, restoreArtwork: mocks.restoreArtwork, getImage: mocks.getImage, getThumbnail: mocks.getThumbnail, setThumbnail: mocks.setThumbnail,
  readLibrarySnapshot: mocks.snapshot, purgeExpiredTrash: vi.fn(async () => ({ purged: 0 })),
} }))
vi.mock('@/composables/useConfirm', () => ({ confirmAction: mocks.confirm }))
vi.mock('@/stores/sceneStore', () => ({ useSceneStore: () => ({ load: async () => {}, scenes: [], loras: [], popularCharacters: [] }) }))
vi.mock('@/composables/useScrollReveal', () => ({ useScrollReveal: () => {} }))
vi.mock('@/composables/useFocusTrap', () => ({ useFocusTrap: () => {} }))
vi.mock('@/composables/useToast', () => ({ useToast: () => ({ show: vi.fn() }) }))
vi.mock('@/utils/imageThumb', () => ({ blobThumbDataUrl: mocks.thumb, jpegThumbDataUrl: vi.fn(() => '') }))
vi.mock('vue-router', () => ({ useRoute: () => reactive(mocks.route), useRouter: () => ({ replace: mocks.replace }) }))
import { useGalleryWorkspace } from './useGalleryWorkspace'

class Observer {
  static instances: Observer[] = []
  elements = new Set<Element>()
  constructor(readonly callback: IntersectionObserverCallback, readonly options: IntersectionObserverInit) { Observer.instances.push(this) }
  observe(element: Element) { this.elements.add(element) }
  unobserve(element: Element) { this.elements.delete(element) }
  disconnect() { this.elements.clear() }
  intersect() {
    this.callback([...this.elements].map(target => ({ target, isIntersecting: true }) as IntersectionObserverEntry), this as unknown as IntersectionObserver)
  }
}

const wrappers: VueWrapper[] = []
const record = (id: number): ArtworkRecord => ({ id, image_id: `image-${id}`, prompt: `work-${id}`, favorite: true, width: 100, height: 200 })

beforeEach(() => {
  vi.clearAllMocks()
  mocks.route.path = '/gallery'
  mocks.route.query = {}
  Observer.instances = []
  vi.stubGlobal('IntersectionObserver', Observer)
  let url = 0
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:gallery-${++url}`)
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  mocks.listTrash.mockReset().mockResolvedValue([])
  mocks.restoreArtwork.mockReset().mockResolvedValue({ restored: true })
  mocks.getImage.mockReset().mockResolvedValue(new Blob(['fixture'], { type: 'image/png' }))
  mocks.getThumbnail.mockReset().mockResolvedValue('data:image/jpeg;base64,thumb')
  mocks.setThumbnail.mockResolvedValue(undefined)
  mocks.thumb.mockReset().mockResolvedValue('data:image/jpeg;base64,generated')
  mocks.snapshot.mockReset().mockImplementation(async () => ({ history: [record(1)], projects: [] }))
})
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); vi.useRealTimers(); vi.unstubAllGlobals() })

async function setup() {
  let gallery!: ReturnType<typeof useGalleryWorkspace>
  const active = ref(true)
  const Gallery = defineComponent({ name: 'GalleryView', setup() {
    gallery = useGalleryWorkspace()
    return () => h('div', { ref: gallery.shellEl }, gallery.pagedVisible.value.map(item => h('article', {
      class: 'artwork', 'data-card-id': String(item.id), key: item.id,
    }, [h('img', { src: gallery.cardUrls[item.id] || gallery.thumbUrls[item.id] || undefined })])))
  } })
  const wrapper = mount(defineComponent({ setup: () => () => h(KeepAlive, null, { default: () => active.value ? h(Gallery) : null }) }))
  wrappers.push(wrapper)
  await flushPromises()
  return { gallery, wrapper,
    async hide() { active.value = false; await nextTick() },
    async show() { active.value = true; await flushPromises() },
    async intersect() { Observer.instances.find(observer => observer.options.rootMargin === '600px 0px')!.intersect(); await flushPromises() },
  }
}

it('keeps the wall mounted when filter URL updates arrive while the viewer is open', async () => {
  const { gallery } = await setup()
  gallery.openViewer(0)
  await flushPromises()
  mocks.snapshot.mockClear()
  const route = useRoute()
  route.query = { tag: '春日' }
  await flushPromises()
  expect(mocks.snapshot).not.toHaveBeenCalled()
  expect(gallery.galleryLoading.value).toBe(false)
  expect(gallery.viewerIndex.value).toBe(0)
  route.query = { q: '雨夜', compare: '1,2' }
  await flushPromises()
  expect(mocks.snapshot).toHaveBeenCalledTimes(1)
  route.query = { q: '秋日', compare: '1,2' }
  await flushPromises()
  expect(mocks.snapshot).toHaveBeenCalledTimes(1)
  route.query = { q: '秋日', compare: '1,2', batch: 'next-batch' }
  await flushPromises()
  expect(mocks.snapshot).toHaveBeenCalledTimes(2)
  gallery.closeViewer(); gallery.onViewerClosed()
  await flushPromises()
  expect(gallery.searchQuery.value).toBe('秋日')
  expect(gallery.tagFilter.value).toBe('')
  expect(mocks.snapshot).toHaveBeenCalledTimes(2)
})

it('opens and closes the narrow information drawer immediately from the keyboard', async () => {
  vi.spyOn(window, 'matchMedia').mockImplementation(query => ({
    matches: query === '(max-width: 900px)', media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  }) as unknown as MediaQueryList)
  const { gallery } = await setup()
  const viewer = document.createElement('div'), toggle = document.createElement('button')
  gallery.viewerEl.value = viewer
  gallery.infoToggleBtn.value = toggle
  const focus = vi.spyOn(toggle, 'focus')
  gallery.openViewer(0)
  const key = new KeyboardEvent('keydown', { key: 'i', bubbles: true, cancelable: true })
  document.dispatchEvent(key)
  expect(gallery.infoOpen.value).toBe(true)
  expect(key.defaultPrevented).toBe(true)
  expect(viewer.hasAttribute('data-info-instant')).toBe(true)
  expect(focus).toHaveBeenCalledOnce()
  gallery.toggleInfoDrawer(new MouseEvent('click', { detail: 1 }))
  expect(gallery.infoOpen.value).toBe(false)
  expect(viewer.hasAttribute('data-info-instant')).toBe(false)
  gallery.toggleInfoDrawer(new MouseEvent('click', { detail: 0 }))
  expect(gallery.infoOpen.value).toBe(true)
  expect(viewer.hasAttribute('data-info-instant')).toBe(true)
  gallery.closeInfoDrawer()
  expect(gallery.infoOpen.value).toBe(false)
  expect(viewer.hasAttribute('data-info-instant')).toBe(true)
})

it('releases gallery originals on deactivation while keeping filters and thumbnails for a return', async () => {
  const env = await setup()
  env.gallery.favoriteOnly.value = true
  await nextTick()
  await env.intersect()
  const original = env.gallery.cardUrls[1]
  expect(original).toBe('blob:gallery-1')
  env.gallery.openViewer(0)
  await flushPromises()
  const viewer = env.gallery.viewerUrl.value
  expect(viewer).toBe('blob:gallery-2')
  await env.hide()
  expect(URL.revokeObjectURL).toHaveBeenCalledWith(original)
  expect(URL.revokeObjectURL).toHaveBeenCalledWith(viewer)
  expect(env.gallery.cardUrls).toEqual({})
  expect(env.gallery.viewerUrl.value).toBe('')
  expect(env.gallery.thumbUrls[1]).toBe('data:image/jpeg;base64,thumb')
  expect(env.gallery.favoriteOnly.value).toBe(true)
  mocks.snapshot.mockResolvedValueOnce({ history: [{ ...record(1), story: 'edited while away' }], projects: [] })
  await env.show()
  expect(env.gallery.history.value[0].story).toBe('edited while away')
  await env.intersect()
  expect(env.gallery.cardUrls[1]).toBe('blob:gallery-3')
  expect(env.gallery.favoriteOnly.value).toBe(true)
  expect(env.wrapper.find('img').attributes('src')).toBe('blob:gallery-3')
})

it('keeps the image and comparison intact until the closing transition finishes', async () => {
  const { gallery } = await setup()
  gallery.openViewer(0)
  await flushPromises()
  const url = gallery.viewerUrl.value
  gallery.compareMode.value = true
  gallery.infoOpen.value = true
  vi.useFakeTimers()
  gallery.closeViewer()
  vi.advanceTimersByTime(1000)
  expect(gallery.viewerIndex.value).toBe(-1)
  expect(gallery.current.value?.id).toBe(1)
  expect(gallery.viewerUrl.value).toBe(url)
  expect(gallery.compareMode.value).toBe(true)
  expect(gallery.infoOpen.value).toBe(true)
  expect(URL.revokeObjectURL).not.toHaveBeenCalled()
  gallery.onViewerClosed()
  expect(gallery.current.value).toBeNull()
  expect(gallery.viewerUrl.value).toBe('')
  expect(gallery.compareMode.value).toBe(false)
  expect(gallery.infoOpen.value).toBe(false)
  expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(url)
})

it('reuses the current image when closing is reversed and ignores an obsolete completion', async () => {
  const { gallery } = await setup()
  gallery.openViewer(0)
  await flushPromises()
  const url = gallery.viewerUrl.value
  gallery.closeViewer()
  gallery.openViewer(0)
  gallery.onViewerClosed()
  await flushPromises()
  expect(gallery.viewerIndex.value).toBe(0)
  expect(gallery.current.value?.id).toBe(1)
  expect(gallery.viewerUrl.value).toBe(url)
  expect(mocks.getImage).toHaveBeenCalledOnce()
  expect(URL.revokeObjectURL).not.toHaveBeenCalled()
})

it('discards a pending image read after closing without disturbing the next artwork', async () => {
  mocks.snapshot.mockResolvedValue({ history: [record(1), record(2)], projects: [] })
  const { gallery } = await setup()
  let finish!: (blob: Blob) => void
  mocks.getImage.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  gallery.openViewer(0)
  gallery.closeViewer()
  gallery.openViewer(1)
  await flushPromises()
  const url = gallery.viewerUrl.value
  finish(new Blob(['old image']))
  await flushPromises()
  expect(gallery.current.value?.id).toBe(gallery.visible.value[1].id)
  expect(gallery.viewerUrl.value).toBe(url)
  expect(URL.createObjectURL).toHaveBeenCalledOnce()
  gallery.closeViewer()
  gallery.onViewerClosed()
  expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(url)
})

it('rejects a late original read after leaving, including a quick return to the same card', async () => {
  let finish!: (blob: Blob) => void
  mocks.getImage.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const env = await setup()
  await env.intersect()
  await env.hide()
  await env.show()
  await env.intersect()
  expect(env.gallery.cardUrls[1]).toBe('blob:gallery-1')
  finish(new Blob(['old original']))
  await flushPromises()
  expect(env.gallery.cardUrls[1]).toBe('blob:gallery-1')
  expect(URL.createObjectURL).toHaveBeenCalledOnce()
  expect(mocks.getImage).toHaveBeenCalledTimes(2)
})

it('does not install an image URL fallback when a hidden page read rejects', async () => {
  let reject!: (error: Error) => void
  mocks.snapshot.mockResolvedValue({ history: [{ ...record(1), image_url: '/assets/fixture.png' }], projects: [] })
  mocks.getImage.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
  const env = await setup()
  await env.intersect()
  await env.hide()
  reject(new Error('read interrupted'))
  await flushPromises()
  expect(env.gallery.cardUrls).toEqual({})
  expect(env.gallery.missingImageIds.value.size).toBe(0)
})

it('discards thumbnail reads and original-derived thumbnail backfills from an earlier activation', async () => {
  let finishThumbnail!: (value: string) => void
  mocks.getThumbnail.mockImplementation(() => new Promise(resolve => { finishThumbnail = resolve }))
  const env = await setup()
  await env.hide()
  finishThumbnail('data:image/jpeg;base64,late')
  await flushPromises()
  expect(env.gallery.thumbUrls).toEqual({})
  mocks.getThumbnail.mockResolvedValue(null)
  let finishDecode!: (value: string) => void
  mocks.thumb.mockImplementationOnce(() => new Promise(resolve => { finishDecode = resolve }))
  await env.show()
  await env.intersect()
  await env.hide()
  finishDecode('data:image/jpeg;base64,late-decode')
  await flushPromises()
  expect(env.gallery.thumbUrls).toEqual({})
  expect(mocks.setThumbnail).not.toHaveBeenCalled()
})

it('keeps only 40 gallery originals while active and releases the remaining URLs on exit', async () => {
  mocks.snapshot.mockImplementation(async () => ({ history: Array.from({ length: 45 }, (_, index) => record(index + 1)), projects: [] }))
  const env = await setup()
  await env.intersect()
  expect(Object.keys(env.gallery.cardUrls)).toHaveLength(40)
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(5)
  await env.hide()
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(45)
  expect(env.gallery.cardUrls).toEqual({})
})

it('keeps gallery previews usable when optional thumbnail persistence fails', async () => {
  mocks.snapshot.mockResolvedValue({ history: [record(1), record(2)], projects: [] })
  mocks.getThumbnail.mockResolvedValue(null)
  mocks.setThumbnail.mockRejectedValueOnce(new DOMException('fixture quota exceeded', 'QuotaExceededError'))
  const env = await setup()
  await env.intersect()
  expect(mocks.setThumbnail).toHaveBeenCalledTimes(2)
  expect(env.gallery.thumbUrls[1]).toBe('data:image/jpeg;base64,generated')
  expect(env.gallery.thumbUrls[2]).toBe('data:image/jpeg;base64,generated')
  expect(Object.keys(env.gallery.cardUrls)).toHaveLength(2)
  expect(env.gallery.galleryError.value).toBe('')
})

it('coalesces overlapping wall thumbnail hydration into one bounded read batch', async () => {
  mocks.snapshot.mockResolvedValue({ history: Array.from({ length: 60 }, (_, index) => record(index + 1)), projects: [] })
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let active = 0, peak = 0
  mocks.getThumbnail.mockImplementation(async () => {
    peak = Math.max(peak, ++active)
    await gate
    active--
    return 'data:image/jpeg;base64,thumb'
  })
  const { gallery } = await setup()
  const initialReads = mocks.getThumbnail.mock.calls.length
  release()
  await flushPromises()
  console.info(JSON.stringify({ fixture: 'gallery-overlapping-thumbnails', records: 60,
    initialReads, totalReads: mocks.getThumbnail.mock.calls.length, peakConcurrentReads: peak }))
  expect(Object.keys(gallery.thumbUrls)).toHaveLength(60)
  expect(mocks.getThumbnail).toHaveBeenCalledTimes(60)
  expect(peak).toBeLessThanOrEqual(8)
})

it('drops queued originals that are no longer visible after a filter change', async () => {
  mocks.snapshot.mockResolvedValue({ history: Array.from({ length: 60 }, (_, index) => record(index + 1)), projects: [] })
  const pending: Array<(blob: Blob) => void> = []
  mocks.getImage.mockImplementation(() => new Promise<Blob>(resolve => { pending.push(resolve) }))
  const env = await setup()
  await env.intersect()
  expect(mocks.getImage).toHaveBeenCalledTimes(4)
  env.gallery.searchQuery.value = 'work-60'
  await flushPromises()
  expect(env.gallery.visible.value.map(item => item.id)).toEqual([60])
  pending.splice(0).forEach(resolve => resolve(new Blob(['already reading'])))
  await flushPromises()
  const nextReads = mocks.getImage.mock.calls.slice(4).map(([imageId]) => imageId)
  console.info(JSON.stringify({ fixture: 'gallery-filter-original-queue', queuedInitially: 60,
    inFlightBeforeFilter: 4, subsequentReads: nextReads }))
  expect(nextReads).toEqual([])
})

it('releases observed cards when filtering to an empty wall and ignores queued observer entries', async () => {
  const env = await setup()
  const observer = Observer.instances.find(item => item.options.rootMargin === '600px 0px')!
  const previousCards = [...observer.elements]
  expect(previousCards).toHaveLength(1)
  env.gallery.searchQuery.value = 'no-matching-artwork'
  await flushPromises()
  expect(env.gallery.visible.value).toEqual([])
  // A queued IntersectionObserver delivery may arrive after its cards detach.
  observer.callback(previousCards.map(target => ({ target, isIntersecting: true }) as IntersectionObserverEntry), observer as unknown as IntersectionObserver)
  await flushPromises()
  expect(mocks.getImage).not.toHaveBeenCalled()
  expect(observer.elements.size).toBe(0)
  expect(env.gallery.cardUrls).toEqual({})
  env.gallery.searchQuery.value = ''
  await flushPromises()
  await env.intersect()
  expect(observer.elements.size).toBe(1)
  expect(mocks.getImage).toHaveBeenCalledExactlyOnceWith('image-1', expect.any(AbortSignal))
})

it('keeps the selected queued original and stops obsolete thumbnail work after filtering', async () => {
  const history = Array.from({ length: 60 }, (_, index) => record(index + 1))
  history[0].prompt = 'only-target'
  mocks.snapshot.mockResolvedValue({ history, projects: [] })
  let releaseThumbs!: () => void
  const gate = new Promise<void>(resolve => { releaseThumbs = resolve })
  mocks.getThumbnail.mockImplementation(async () => { await gate; return null })
  const pending: Array<(blob: Blob) => void> = []
  mocks.getImage.mockImplementation(() => new Promise<Blob>(resolve => { pending.push(resolve) }))
  const env = await setup()
  await env.intersect()
  env.gallery.searchQuery.value = 'only-target'
  await flushPromises()
  releaseThumbs()
  pending.splice(0).forEach(resolve => resolve(new Blob(['already reading'])))
  await flushPromises()
  expect(env.gallery.visible.value.map(item => item.id)).toEqual([1])
  expect(mocks.getThumbnail.mock.calls.map(([imageId]) => imageId)).toEqual([
    'image-60', 'image-59', 'image-58', 'image-57', 'image-56', 'image-55', 'image-54', 'image-53', 'image-1',
  ])
  expect(mocks.getImage.mock.calls.slice(4).map(([imageId]) => imageId)).toEqual(['image-1'])
})


it('cancels delayed filter URL changes when leaving and resumes sync after returning', async () => {
  const env = await setup()
  vi.useFakeTimers()
  env.gallery.searchQuery.value = 'work'
  await nextTick()
  await env.hide()
  const route = useRoute()
  route.path = '/studio'
  route.query = { project: 'another-project' }
  await vi.advanceTimersByTimeAsync(300)
  expect(mocks.replace).not.toHaveBeenCalled()
  expect(route.query).toEqual({ project: 'another-project' })
  route.path = '/gallery'
  route.query = {}
  await env.show()
  env.gallery.searchQuery.value = 'work-1'
  await nextTick()
  await vi.advanceTimersByTimeAsync(300)
  expect(mocks.replace).toHaveBeenCalledExactlyOnceWith({ query: { q: 'work-1' } })
})

it.each(['temporary failure', 'missing image'])('rechecks a %s after reactivation instead of caching it forever', async failure => {
  if (failure === 'temporary failure') mocks.getImage.mockRejectedValueOnce(new Error('temporary transport failure'))
  else mocks.getImage.mockResolvedValueOnce(null)
  const env = await setup()
  await env.intersect()
  expect(mocks.getImage).toHaveBeenCalledTimes(1)
  expect(env.gallery.missingImageIds.value.has(1)).toBe(true)
  // Avoid retry loops while this activation is still visible.
  await env.intersect()
  expect(mocks.getImage).toHaveBeenCalledTimes(1)
  await env.hide()
  await env.show()
  await env.intersect()
  expect(mocks.getImage).toHaveBeenCalledTimes(2)
  expect(env.gallery.missingImageIds.value.has(1)).toBe(false)
  expect(env.gallery.cardUrls[1]).toBe('blob:gallery-1')
})


it('loads trash exactly once on opening and on an active-trash KeepAlive return', async () => {
  const env = await setup()
  expect(mocks.listTrash).not.toHaveBeenCalled()
  env.gallery.toggleTrashMode()
  await flushPromises()
  expect(mocks.listTrash).toHaveBeenCalledTimes(1)
  await env.hide()
  await env.show()
  expect(mocks.listTrash).toHaveBeenCalledTimes(2)
  env.gallery.toggleTrashMode()
  await env.hide()
  await env.show()
  expect(mocks.listTrash).toHaveBeenCalledTimes(2)
  env.gallery.toggleTrashMode()
  await flushPromises()
  expect(mocks.listTrash).toHaveBeenCalledTimes(3)
})


it('invalidates a bulk-delete approval when the gallery leaves and returns', async () => {
  let resolve!: (approved: boolean) => void
  mocks.confirm.mockReturnValueOnce(new Promise<boolean>(done => { resolve = done }))
  const env = await setup()
  env.gallery.selectedIds.value = new Set([1])
  const pending = env.gallery.bulkDelete()
  await env.hide()
  await env.show()
  resolve(true)
  await pending
  expect(mocks.softDeleteArtworks).not.toHaveBeenCalled()
  expect(env.gallery.history.value.map(item => item.id)).toContain(1)
  expect(env.gallery.bulkDeleting.value).toBe(false)
})


it('cancels obsolete in-flight originals so a newly selected album does not wait for their downloads', async () => {
  const history = Array.from({ length: 8 }, (_, index) => record(index + 1))
  history[0].prompt = 'new-album-target'
  mocks.snapshot.mockResolvedValue({ history, projects: [] })
  const reads: Array<{ id: string; signal: AbortSignal; resolve(blob: Blob): void }> = []
  mocks.getImage.mockImplementation((id: string, signal: AbortSignal) => new Promise<Blob>((resolve, reject) => {
    reads.push({ id, signal, resolve })
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  }))
  const env = await setup()
  await env.intersect()
  expect(reads).toHaveLength(4)
  env.gallery.searchQuery.value = 'new-album-target'
  await flushPromises()
  expect(reads.slice(0, 4).every(read => read.signal.aborted)).toBe(true)
  expect(reads.map(read => read.id)).toEqual(['image-8', 'image-7', 'image-6', 'image-5', 'image-1'])
  reads[4].resolve(new Blob(['new target']))
  await flushPromises()
  expect(Object.keys(env.gallery.cardUrls)).toEqual(['1'])
  expect(env.gallery.missingImageIds.value.size).toBe(0)
})

it.each(['album overview', 'trash'] as const)('stops hidden wall reads in %s and rejects late originals or fallbacks', async surface => {
  mocks.snapshot.mockResolvedValue({ history: Array.from({ length: 6 }, (_, index) => ({ ...record(index + 1), image_url: '/old-fallback.png' })), projects: [] })
  const reads: Array<{ signal: AbortSignal; resolve(blob: Blob): void }> = []
  mocks.getImage.mockImplementation((_id: string, signal: AbortSignal) => new Promise<Blob>(resolve => { reads.push({ signal, resolve }) }))
  const env = await setup()
  await env.intersect()
  expect(reads).toHaveLength(4)
  if (surface === 'album overview') env.gallery.collectionPreviewItems.value = []
  else env.gallery.toggleTrashMode()
  await flushPromises()
  expect(reads.every(read => read.signal.aborted)).toBe(true)
  reads.forEach(read => read.resolve(new Blob(['ignored late image'])))
  await flushPromises()
  await env.intersect()
  expect(reads).toHaveLength(4)
  expect(URL.createObjectURL).not.toHaveBeenCalled()
  expect(env.gallery.cardUrls).toEqual({})
  expect(env.gallery.missingImageIds.value.size).toBe(0)
  mocks.getImage.mockResolvedValue(new Blob(['visible again']))
  if (surface === 'album overview') env.gallery.collectionPreviewItems.value = null
  else env.gallery.toggleTrashMode()
  await flushPromises()
  await env.intersect()
  expect(Object.keys(env.gallery.cardUrls)).toHaveLength(6)
})


it('replaces same-ID media without evicting unchanged cards or publishing obsolete reads', async () => {
  mocks.snapshot.mockResolvedValue({ history: [record(1), record(2)], projects: [] })
  const env = await setup()
  await env.intersect()
  const old = env.gallery.cardUrls[1], unchanged = env.gallery.cardUrls[2]
  env.gallery.openViewer(env.gallery.visible.value.findIndex(item => item.id === 1))
  await flushPromises()
  const oldViewer = env.gallery.viewerUrl.value
  const oldReads: Array<{ signal: AbortSignal; finish: (blob: Blob) => void }> = []
  mocks.getImage.mockImplementation((id, signal) => id === 'pending-image'
    ? new Promise<Blob>(finish => { oldReads.push({ signal, finish }) })
    : Promise.resolve(new Blob([id])))
  env.gallery.history.value = [{ ...record(1), image_id: 'pending-image' }, record(2)]
  await flushPromises()
  await env.intersect()
  expect(URL.revokeObjectURL).toHaveBeenCalledWith(old)
  expect(URL.revokeObjectURL).toHaveBeenCalledWith(oldViewer)
  expect(env.gallery.cardUrls[2]).toBe(unchanged)
  mocks.getThumbnail.mockImplementation(async id => `data:image/jpeg;base64,${id}`)
  env.gallery.history.value = [{ ...record(1), image_id: 'latest-image' }, record(2)]
  await flushPromises()
  await env.intersect()
  expect(oldReads).toHaveLength(2)
  expect(oldReads.every(read => read.signal.aborted)).toBe(true)
  const latest = env.gallery.cardUrls[1], latestViewer = env.gallery.viewerUrl.value
  expect(env.gallery.thumbUrls[1]).toBe('data:image/jpeg;base64,latest-image')
  oldReads.forEach(read => read.finish(new Blob(['obsolete'])))
  await flushPromises()
  expect(env.gallery.cardUrls[1]).toBe(latest)
  expect(env.gallery.viewerUrl.value).toBe(latestViewer)
  expect(env.gallery.cardUrls[2]).toBe(unchanged)
})
