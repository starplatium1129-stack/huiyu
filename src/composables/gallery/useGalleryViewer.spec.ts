import { expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, ref } from 'vue'
import type { ArtworkRecord } from '@/types/artwork'
import { useGalleryViewer } from './useGalleryViewer'

const mocks = vi.hoisted(() => ({ read: vi.fn(), thumbnail: vi.fn() }))
vi.mock('@/storage/artworkRepository', () => ({ artworkRepository: { getImage: mocks.read, getThumbnail: mocks.thumbnail } }))

it('switching, closing and unmounting cancel obsolete original reads without late publication', async () => {
  const signals: AbortSignal[] = [], finish: Array<(blob: Blob) => void> = []
  mocks.read.mockImplementation((_id, signal) => {
    signals.push(signal)
    return new Promise<Blob>(resolve => finish.push(resolve))
  })
  const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:current')
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  let viewer!: ReturnType<typeof useGalleryViewer>
  const wrapper = mount(defineComponent({ setup() {
    const history = ref([{ id: 'a', image_id: 'a' }, { id: 'b', image_id: 'b' }])
    viewer = useGalleryViewer({ history, visible: history, resetControls() {} })
    return () => null
  } }))
  viewer.openViewer(0); viewer.openViewer(1)
  expect(signals[0].aborted).toBe(true)
  expect(signals[1].aborted).toBe(false)
  finish[0](new Blob(['old'])); finish[1](new Blob(['current']))
  await flushPromises()
  expect(create).toHaveBeenCalledTimes(1)
  viewer.openViewer(0); viewer.closeViewer()
  expect(signals[2].aborted).toBe(true)
  viewer.openViewer(1); wrapper.unmount()
  expect(signals[3].aborted).toBe(true)
  expect(revoke).toHaveBeenCalledWith('blob:current')
  finish[2](new Blob(['closed'])); finish[3](new Blob(['unmounted']))
  await flushPromises()
  expect(create).toHaveBeenCalledTimes(1)
})


it('reuses an in-flight original on repeated opens but retries after cancellation', async () => {
  const reads: Array<{ signal: AbortSignal; finish(blob: Blob): void }> = []
  mocks.read.mockReset().mockImplementation((_id, signal) => new Promise<Blob>(finish => reads.push({ signal, finish })))
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:reopened')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  let viewer!: ReturnType<typeof useGalleryViewer>
  const wrapper = mount(defineComponent({ setup() {
    const history = ref([{ id: 'a', image_id: 'large-original' }])
    viewer = useGalleryViewer({ history, visible: history, resetControls() {} })
    return () => null
  } }))
  try {
    viewer.openViewer(0); viewer.openViewer(0)
    expect(reads).toHaveLength(1)
    expect(reads[0].signal.aborted).toBe(false)
    viewer.closeViewer(); viewer.openViewer(0)
    expect(reads[0].signal.aborted).toBe(true)
    expect(reads).toHaveLength(2)
    reads[0].finish(new Blob(['obsolete']))
    await flushPromises()
    expect(viewer.viewerUrl.value).toBe('')
    reads[1].finish(new Blob(['current']))
    await flushPromises()
    expect(viewer.viewerUrl.value).toBe('blob:reopened')
  } finally { wrapper.unmount() }
})

it.each([
  { image_url: 'https://example.com/neutral.png', expected: 'https://example.com/neutral.png' },
  { image_data: 'data:image/png;base64,fixture', expected: 'data:image/png;base64,fixture' },
  { image_url: 'javascript:alert(1)', expected: '' },
])('uses the safe original fallback when storage fails: $expected', async ({ expected, ...media }) => {
  mocks.read.mockReset().mockRejectedValue(new Error('storage unavailable'))
  let viewer!: ReturnType<typeof useGalleryViewer>
  const wrapper = mount(defineComponent({ setup() {
    const history = ref<ArtworkRecord[]>([{ id: 'a', image_id: 'missing-original', ...media }])
    viewer = useGalleryViewer({ history, visible: history, resetControls() {} })
    return () => null
  } }))
  try {
    viewer.openViewer(0)
    await flushPromises()
    expect(viewer.viewerUrl.value).toBe(expected)
  } finally { wrapper.unmount() }
})


it('does not publish fallback from an obsolete or closed original read', async () => {
  const failures: Array<() => void> = []
  mocks.read.mockReset().mockImplementation(() => new Promise((_resolve, reject) => failures.push(() => reject(new Error('unavailable')))))
  let viewer!: ReturnType<typeof useGalleryViewer>
  const wrapper = mount(defineComponent({ setup() {
    const history = ref([{ id: 'a', image_id: 'a', image_url: 'https://example.com/a.png' },
      { id: 'b', image_id: 'b', image_url: 'https://example.com/b.png' }])
    viewer = useGalleryViewer({ history, visible: history, resetControls() {} })
    return () => null
  } }))
  try {
    viewer.openViewer(0); viewer.openViewer(1)
    failures[0]()
    await flushPromises()
    expect(viewer.viewerUrl.value).toBe('')
    viewer.closeViewer()
    failures[1]()
    await flushPromises()
    expect(viewer.viewerUrl.value).toBe('')
  } finally { wrapper.unmount() }
})

it('borrows cached neighbor media and ignores late thumbnail replies after switching and closing', async () => {
  const reads: Array<{ id: string; finish(value: string): void }> = []
  mocks.read.mockReset().mockResolvedValue(null)
  mocks.thumbnail.mockReset().mockImplementation(id => new Promise<string>(finish => reads.push({ id, finish })))
  let viewer!: ReturnType<typeof useGalleryViewer>
  const history = ref<ArtworkRecord[]>(Array.from({ length: 5 }, (_, index) => ({ id: String(index), image_id: `image-${index}` })))
  const wrapper = mount(defineComponent({ setup() {
    viewer = useGalleryViewer({ history, visible: history, previewSource: item => item.id === '0' ? 'blob:borrowed' : '', resetControls() {} })
    return () => null
  } }))
  try {
    viewer.openViewer(0)
    expect(reads.map(item => item.id)).toEqual(['image-1', 'image-2'])
    viewer.openViewer(3)
    expect(reads.slice(2).map(item => item.id)).toEqual(['image-1', 'image-2', 'image-3', 'image-4'])
    reads[0].finish('data:image/png;base64,obsolete')
    reads[1].finish('data:image/png;base64,obsolete')
    reads[3].finish('data:image/png;base64,neighbor')
    await flushPromises()
    expect(viewer.neighborPreviews.value).toEqual({ '2': 'data:image/png;base64,neighbor' })
    viewer.closeViewer(); viewer.onViewerClosed()
    reads[2].finish('data:image/png;base64,closed'); reads[4].finish('data:image/png;base64,closed'); reads[5].finish('data:image/png;base64,closed')
    await flushPromises()
    expect(viewer.neighborPreviews.value).toEqual({})
  } finally { wrapper.unmount() }
})
