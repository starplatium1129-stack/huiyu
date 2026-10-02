import { afterEach, beforeEach, vi } from 'vitest'
import { defineComponent, h, nextTick, reactive, ref } from 'vue'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import type { ArtworkRecord } from '@/types/artwork'
import { createGalleryKeepAliveHost } from './galleryWorkspaceKeepAliveHost'

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(), softDeleteArtworks: vi.fn(), listTrash: vi.fn(), restoreArtwork: vi.fn(), getImage: vi.fn(), getThumbnail: vi.fn(), setThumbnail: vi.fn(), snapshot: vi.fn(), thumb: vi.fn(),
  route: { path: '/gallery', query: {} }, replace: vi.fn(),
  sceneStore: { load: vi.fn(), loadHome: vi.fn(), loadLoraCatalog: vi.fn(),
    scenes: [] as Array<{ id: string; title: string }>, loras: [] as Array<{ id: string; name: string }>,
    popularCharacters: [] as Array<{ id: string; displayName: string }> },
}))
vi.mock('@/storage/artworkRepository', () => ({ artworkRepository: {
  softDeleteArtworks: mocks.softDeleteArtworks, listTrash: mocks.listTrash, restoreArtwork: mocks.restoreArtwork, getImage: mocks.getImage, getThumbnail: mocks.getThumbnail, setThumbnail: mocks.setThumbnail,
  readLibrarySnapshot: mocks.snapshot, purgeExpiredTrash: vi.fn(async () => ({ purged: 0 })),
} }))
vi.mock('@/composables/useConfirm', () => ({ confirmAction: mocks.confirm }))
vi.mock('@/stores/sceneStore', () => ({ useSceneStore: () => reactive(mocks.sceneStore) }))
vi.mock('@/composables/useScrollReveal', () => ({ useScrollReveal: () => {} }))
vi.mock('@/composables/useFocusTrap', () => ({ useFocusTrap: () => ({ returnFocus: ref(null) }) }))
vi.mock('@/composables/useToast', () => ({ useToast: () => ({ show: vi.fn() }) }))
vi.mock('@/utils/imageThumb', () => ({ blobThumbDataUrl: mocks.thumb, jpegThumbDataUrl: vi.fn(() => '') }))
vi.mock('vue-router', () => ({ useRoute, useRouter: () => ({ replace: mocks.replace }) }))
import { useGalleryWorkspace } from './useGalleryWorkspace'

export class Observer {
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
export const record = (id: number): ArtworkRecord => ({ id, image_id: `image-${id}`, prompt: `work-${id}`, favorite: true, width: 100, height: 200 })

beforeEach(() => {
  vi.clearAllMocks()
  mocks.route.path = '/gallery'
  mocks.route.query = {}
  mocks.sceneStore.load.mockReset().mockResolvedValue(undefined)
  mocks.sceneStore.loadHome.mockReset().mockResolvedValue(undefined)
  mocks.sceneStore.loadLoraCatalog.mockReset().mockResolvedValue(undefined)
  mocks.sceneStore.scenes = []; mocks.sceneStore.loras = []; mocks.sceneStore.popularCharacters = []
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

export async function setup() {
  let gallery!: ReturnType<typeof useGalleryWorkspace>
  const active = ref(true)
  const Gallery = defineComponent({ name: 'GalleryView', setup() {
    gallery = useGalleryWorkspace()
    return () => h('div', { ref: gallery.shellEl }, gallery.pagedVisible.value.map(item => h('article', {
      class: 'artwork', 'data-card-id': String(item.id), key: item.id,
    }, [h('img', { src: gallery.cardUrls[item.id] || gallery.thumbUrls[item.id] || undefined })])))
  } })
  const wrapper = mount(createGalleryKeepAliveHost(active, Gallery))
  wrappers.push(wrapper)
  await flushPromises()
  return { gallery, wrapper,
    async hide() { active.value = false; await nextTick() },
    async show() { active.value = true; await flushPromises() },
    async intersect() { Observer.instances.find(observer => observer.options.rootMargin === '600px 0px')!.intersect(); await flushPromises() },
  }
}


export function useRoute() { return reactive(mocks.route) }
export { mocks }
