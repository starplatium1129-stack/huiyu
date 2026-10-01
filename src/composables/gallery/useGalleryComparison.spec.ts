import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computed, defineComponent, h, KeepAlive, nextTick, reactive, ref } from 'vue'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import type { RouteLocationNormalizedLoaded } from 'vue-router'
import type { ArtworkRecord } from '@/types/artwork'

const media = vi.hoisted(() => ({ getThumbnail: vi.fn(), getImage: vi.fn() }))
vi.mock('@/storage/artworkRepository', () => ({ artworkRepository: media }))
import { useGalleryComparison } from './useGalleryComparison'

const record = (id: number, parent_id?: number): ArtworkRecord => ({ id, image_id: `image-${id}`, parent_id, prompt: '' })
const childThumb = 'data:image/jpeg;base64,child'
const parentThumb = 'data:image/jpeg;base64,parent'
const wrappers: VueWrapper[] = []
beforeEach(() => {
  vi.clearAllMocks()
  media.getThumbnail.mockReset().mockResolvedValue(parentThumb)
  media.getImage.mockReset().mockResolvedValue(new Blob(['mock parent']))
  let count = 0
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:parent-${++count}`)
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
})
afterEach(() => wrappers.splice(0).forEach(wrapper => wrapper.unmount()))

async function setup() {
  // Parent zero is valid, exists in metadata, and has never entered the wall cache.
  const history = ref([record(1, 0), record(0), record(2, 3), record(3)])
  const currentId = ref<number | null>(null), active = ref(true)
  const thumbUrls = reactive<Record<string, string>>({ 1: childThumb, 2: childThumb })
  const cardUrls = reactive<Record<string, string>>({})
  let comparison!: ReturnType<typeof useGalleryComparison>
  const View = defineComponent({ name: 'ComparisonFixture', setup() {
    comparison = useGalleryComparison({ history, thumbUrls, cardUrls,
      current: computed(() => history.value.find(item => item.id === currentId.value) || null),
      selectedIds: ref(new Set()), route: { path: '/gallery', query: {} } as RouteLocationNormalizedLoaded })
    return () => h('img', { src: comparison.parentImageUrl.value || undefined })
  } })
  const wrapper = mount({ setup: () => () => h(KeepAlive, null, {
    default: () => active.value ? h(View) : null,
  }) })
  wrappers.push(wrapper)
  await flushPromises()
  return { history, currentId, active, thumbUrls, cardUrls, comparison, wrapper }
}

it('loads an off-wall parent before offering child-thumbnail fallback without populating wall caches', async () => {
  let finish!: (value: string | null) => void
  media.getThumbnail.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const env = await setup()
  expect(media.getThumbnail).not.toHaveBeenCalled()
  env.currentId.value = 1
  await nextTick()
  expect(media.getThumbnail).toHaveBeenCalledExactlyOnceWith('image-0')
  expect(env.comparison.hasComparableImage.value).toBe(false)
  finish(parentThumb)
  await flushPromises()
  expect(env.comparison.parentImageUrl.value).toBe(parentThumb)
  expect(env.comparison.hasComparableImage.value).toBe(true)
  expect(media.getImage).not.toHaveBeenCalled()
  expect(env.thumbUrls).toEqual({ 1: childThumb, 2: childThumb })
  expect(env.cardUrls).toEqual({})
  env.currentId.value = null
  await nextTick()
  media.getThumbnail.mockResolvedValue(null)
  media.getImage.mockResolvedValue(null)
  env.currentId.value = 1
  await flushPromises()
  expect(env.comparison.parentImageUrl.value).toBe('')
  expect(env.comparison.hasComparableImage.value).toBe(true)
})

it('cancels owned original fallback on deactivation and retains reentered previews until final viewer close', async () => {
  media.getThumbnail.mockResolvedValue(null)
  let finish!: (value: Blob) => void
  media.getImage.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const env = await setup()
  env.currentId.value = 1
  await flushPromises()
  const signal = media.getImage.mock.calls[0][1] as AbortSignal
  env.active.value = false
  await nextTick()
  expect(signal.aborted).toBe(true)
  finish(new Blob(['obsolete mock parent']))
  await flushPromises()
  expect(URL.createObjectURL).not.toHaveBeenCalled()
  env.active.value = true
  await flushPromises()
  const preview = env.comparison.parentImageUrl.value
  expect(preview).toBe('blob:parent-1')
  // Viewer close keeps current alive until its existing leave transition ends.
  env.comparison.compareMode.value = false
  await nextTick()
  expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(preview)
  expect(env.comparison.parentImageUrl.value).toBe(preview)
  env.currentId.value = null
  await nextTick()
  expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(preview)
  expect(env.comparison.parentImageUrl.value).toBe('')
})

it('rejects obsolete parent/viewer thumbnail reads and does not reload for metadata-only changes', async () => {
  const reads: Array<{ id: string; finish: (value: string) => void }> = []
  media.getThumbnail.mockImplementation(id => new Promise(resolve => { reads.push({ id, finish: resolve }) }))
  const env = await setup()
  env.currentId.value = 1
  await nextTick()
  env.history.value = env.history.value.map(item => item.id === 0 ? { ...item, image_id: 'replacement' } : item)
  await nextTick()
  expect(reads.map(read => read.id)).toEqual(['image-0', 'replacement'])
  reads[0].finish('data:image/jpeg;base64,obsolete-source')
  await flushPromises()
  expect(env.comparison.parentImageUrl.value).toBe('')
  env.currentId.value = 2
  await nextTick()
  reads[1].finish('data:image/jpeg;base64,obsolete-viewer')
  reads[2].finish(parentThumb)
  await flushPromises()
  expect(env.comparison.parentImageUrl.value).toBe(parentThumb)
  env.history.value = env.history.value.map(item => ({ ...item, favorite: true }))
  await nextTick()
  expect(reads).toHaveLength(3)
  expect(media.getImage).not.toHaveBeenCalled()
  expect(env.wrapper.find('img').attributes('src')).toBe(parentThumb)
})
