import { expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, ref } from 'vue'
import { useGalleryViewer } from './useGalleryViewer'

const mocks = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('@/storage/artworkRepository', () => ({ artworkRepository: { getImage: mocks.read } }))

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
