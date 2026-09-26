import { afterEach, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import PhotoSwipeStage from './PhotoSwipeStage.vue'

const mocks = vi.hoisted(() => ({ read: vi.fn(), failed: vi.fn(), destroyed: vi.fn(), refreshed: vi.fn(), init: vi.fn() }))
vi.mock('@/storage/artworkRepository', () => ({ artworkRepository: { getImage: mocks.read } }))
vi.mock('photoswipe', () => ({ default: class {
  events: Record<string, (event: unknown) => void> = {}
  currIndex = 0
  on(name: string, callback: (event: unknown) => void) { this.events[name] = callback }
  refreshSlideContent(index: number) { mocks.refreshed(index) }
  init() { mocks.init(); this.events.contentLoad({ content: { index: 0, onError: mocks.failed }, preventDefault() {} }) }
  updateSize() {}
  setScrollOffset() {}
  destroy() { mocks.destroyed() }
} }))
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks() })

it('closing during decode immediately releases its URL and rejects late publication', async () => {
  mocks.read.mockResolvedValue(new Blob(['fixture'], { type: 'image/png' }))
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:pending-decode')
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  let finish!: () => void
  let decodingImage!: HTMLImageElement
  vi.spyOn(HTMLImageElement.prototype, 'decode').mockImplementation(function (this: HTMLImageElement) {
    decodingImage = this
    return new Promise<void>(resolve => { finish = resolve })
  })
  const wrapper = mount(PhotoSwipeStage, { props: { items: [{ id: 1, image_id: 'one' }], index: 0 } })
  await flushPromises()
  expect(decodingImage.src).toBe('blob:pending-decode')
  wrapper.unmount()
  expect(revoke).toHaveBeenCalledWith('blob:pending-decode')
  expect(decodingImage.getAttribute('src')).toBeNull()
  finish(); await flushPromises()
  expect(mocks.failed).not.toHaveBeenCalled()
  expect(mocks.destroyed).toHaveBeenCalledOnce()
  expect(mocks.refreshed).not.toHaveBeenCalled()
  expect(revoke).toHaveBeenCalledTimes(1)
})

it('A-B-A switching discards old storage reads and owns only new URLs', async () => {
  let first!: (blob: Blob) => void
  mocks.read.mockImplementationOnce(() => new Promise<Blob>(resolve => { first = resolve }))
    .mockResolvedValue(new Blob(['new']))
  const create = vi.spyOn(URL, 'createObjectURL').mockReturnValueOnce('blob:b').mockReturnValueOnce('blob:a-new')
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  vi.spyOn(HTMLImageElement.prototype, 'decode').mockResolvedValue()
  const wrapper = mount(PhotoSwipeStage, { props: { items: [{ id: 'a', image_id: 'a' }], index: 0 } })
  await flushPromises()
  await wrapper.setProps({ items: [{ id: 'b', image_id: 'b' }] }); await flushPromises()
  await wrapper.setProps({ items: [{ id: 'a', image_id: 'a' }] }); await flushPromises()
  first(new Blob(['old'])); await flushPromises()
  expect(create).toHaveBeenCalledTimes(2)
  expect(mocks.refreshed).toHaveBeenCalledTimes(2)
  wrapper.unmount()
  expect(revoke.mock.calls).toEqual([['blob:b'], ['blob:a-new']])
})

it('decode failure releases exactly once and reports a local image error', async () => {
  mocks.read.mockResolvedValue(new Blob(['bad']))
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:bad')
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  vi.spyOn(HTMLImageElement.prototype, 'decode').mockRejectedValue(new Error('decode'))
  const wrapper = mount(PhotoSwipeStage, { props: { items: [{ id: 1, image_id: 'bad' }], index: 0 } })
  await flushPromises(); wrapper.unmount()
  expect(mocks.failed).toHaveBeenCalledOnce()
  expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:bad')
})

it('partial initialization emits fallback and disposes the viewer', async () => {
  mocks.init.mockImplementationOnce(() => { throw new Error('init') })
  const wrapper = mount(PhotoSwipeStage, { props: { items: [{ id: 1 }], index: 0 } })
  await flushPromises()
  expect(wrapper.emitted('error')).toHaveLength(1)
  wrapper.unmount()
  expect(mocks.destroyed).toHaveBeenCalledOnce()
})

it('external HTTP images are never revoked by the adapter', async () => {
  vi.spyOn(HTMLImageElement.prototype, 'decode').mockResolvedValue()
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  const wrapper = mount(PhotoSwipeStage, { props: { items: [{ id: 1, image_url: '/fixture.png' }], index: 0 } })
  await flushPromises(); wrapper.unmount()
  expect(mocks.refreshed).toHaveBeenCalledOnce()
  expect(revoke).not.toHaveBeenCalled()
})
