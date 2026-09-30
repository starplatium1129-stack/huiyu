import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { defineComponent, h, KeepAlive, nextTick, reactive, ref } from 'vue'
import { useRoute } from 'vue-router'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import type { ArtworkRecord } from '@/types/artwork'

const mocks = vi.hoisted(() => ({
  getImage: vi.fn(), getThumbnail: vi.fn(), setThumbnail: vi.fn(), snapshot: vi.fn(), thumb: vi.fn(),
  route: { path: '/gallery', query: {} }, replace: vi.fn(),
}))
vi.mock('@/storage/artworkRepository', () => ({ artworkRepository: {
  getImage: mocks.getImage, getThumbnail: mocks.getThumbnail, setThumbnail: mocks.setThumbnail,
  readLibrarySnapshot: mocks.snapshot, purgeExpiredTrash: vi.fn(async () => ({ purged: 0 })),
} }))
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
  mocks.route.query = {}
  Observer.instances = []
  vi.stubGlobal('IntersectionObserver', Observer)
  let url = 0
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:gallery-${++url}`)
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
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
