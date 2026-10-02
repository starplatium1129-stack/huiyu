import { afterEach, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import PhotoSwipeStage from './PhotoSwipeStage.vue'

const mocks = vi.hoisted(() => ({ read: vi.fn(), failed: vi.fn(), destroyed: vi.fn(), refreshed: vi.fn(), init: vi.fn(), change: vi.fn(), removed: vi.fn(), created: vi.fn(), stopped: vi.fn(), zoom: vi.fn() }))
vi.mock('@/storage/artworkRepository', () => ({ artworkRepository: { getImage: mocks.read } }))
vi.mock('photoswipe', () => ({ default: class {
  events: Record<string, (event: unknown) => void> = {}
  currIndex = 0
  contentLoader = { getContentByIndex: () => undefined, removeByIndex: mocks.removed }
  animations = { stopAll: mocks.stopped }
  constructor(public options: { zoomAnimationDuration: number }) { mocks.created(this); mocks.change.mockImplementation((index: number) => { this.currIndex = index; this.events.change(undefined) }) }
  on(name: string, callback: (event: unknown) => void) { this.events[name] = callback }
  refreshSlideContent(index: number) { mocks.refreshed(index) }
  init() { mocks.init(); this.events.contentLoad({ content: { index: 0, onError: mocks.failed }, preventDefault() {} }) }
  updateSize() {}
  setScrollOffset() {}
  destroy() { mocks.destroyed() }
  toggleZoom() { mocks.zoom(this.options.zoomAnimationDuration) }
} }))
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); delete document.documentElement.dataset.motion })

it('moving outside the preload neighborhood aborts and evicts unfinished slide content', async () => {
  mocks.read.mockImplementationOnce(() => new Promise(() => {}))
  const wrapper = mount(PhotoSwipeStage, { props: { items: [{ id: 0, image_id: 'zero' }, { id: 1 }, { id: 2 }, { id: 3 }], index: 0 } })
  await flushPromises()
  const signal = mocks.read.mock.calls[0][1] as AbortSignal
  mocks.change(3)
  expect(signal.aborted).toBe(true)
  expect(mocks.removed).toHaveBeenCalledWith(0)
  expect(mocks.failed).not.toHaveBeenCalled()
  wrapper.unmount()
})

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

it('leaving the preload neighborhood clears a pending decode without publishing it', async () => {
  mocks.read.mockResolvedValue(new Blob(['fixture'], { type: 'image/png' }))
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:obsolete-decode')
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  let finish!: () => void
  let decodingImage!: HTMLImageElement
  vi.spyOn(HTMLImageElement.prototype, 'decode').mockImplementation(function (this: HTMLImageElement) {
    decodingImage = this
    return new Promise<void>(resolve => { finish = resolve })
  })
  const wrapper = mount(PhotoSwipeStage, { props: { items: Array.from({ length: 4 }, (_, id) => ({ id, image_id: `image-${id}` })), index: 0 } })
  try {
    await flushPromises()
    const signal = mocks.read.mock.calls[0][1] as AbortSignal
    mocks.change(2)
    expect(signal.aborted).toBe(false)
    expect(decodingImage.getAttribute('src')).toBe('blob:obsolete-decode')
    expect(revoke).not.toHaveBeenCalled()
    mocks.change(3)
    expect(signal.aborted).toBe(true)
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:obsolete-decode')
    expect(decodingImage.getAttribute('src')).toBeNull()
    finish(); await flushPromises()
    expect(mocks.refreshed).not.toHaveBeenCalled()
    expect(mocks.failed).not.toHaveBeenCalled()
  } finally {
    finish?.()
    wrapper.unmount()
    await flushPromises()
  }
})

it.each([false, true])('media switching (same ID: %s) rejects old reads while metadata preserves the viewer', async sameId => {
  let first!: (blob: Blob) => void
  mocks.read.mockImplementationOnce(() => new Promise<Blob>(resolve => { first = resolve }))
    .mockResolvedValue(new Blob(['new']))
  const create = vi.spyOn(URL, 'createObjectURL').mockReturnValueOnce('blob:b').mockReturnValueOnce('blob:a-new')
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  vi.spyOn(HTMLImageElement.prototype, 'decode').mockResolvedValue()
  const wrapper = mount(PhotoSwipeStage, { props: { items: [{ id: 'a', image_id: 'a' }], index: 0 } })
  await flushPromises()
  await wrapper.setProps({ items: [{ id: 'a', image_id: 'a', sceneTitle: 'Renamed' }] }); await flushPromises()
  expect(mocks.destroyed).not.toHaveBeenCalled()
  expect(mocks.read).toHaveBeenCalledTimes(1)
  await wrapper.setProps({ items: [{ id: sameId ? 'a' : 'b', image_id: 'b' }] }); await flushPromises()
  expect(mocks.read.mock.calls[0][1].aborted).toBe(true)
  await wrapper.setProps({ items: [{ id: 'a', image_id: 'a-new' }] }); await flushPromises()
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

it('honors the app motion preference while open and keeps keyboard zoom immediate', async () => {
  mocks.read.mockResolvedValue(null)
  document.documentElement.dataset.motion = 'full'
  const wrapper = mount(PhotoSwipeStage, { props: { items: [{ id: 1 }], index: 0 } })
  const instance = mocks.created.mock.calls.at(-1)![0] as { options: { zoomAnimationDuration: number } }
  await wrapper.get('button').trigger('click', { detail: 0 })
  expect(mocks.zoom).toHaveBeenLastCalledWith(0)
  expect(instance.options.zoomAnimationDuration).toBe(160)
  document.documentElement.dataset.motion = 'reduce'
  window.dispatchEvent(new Event('atelier:motion-preference'))
  expect(instance.options.zoomAnimationDuration).toBe(0)
  expect(mocks.stopped).toHaveBeenCalledOnce()
  wrapper.unmount()
  window.dispatchEvent(new Event('atelier:motion-preference'))
  expect(mocks.stopped).toHaveBeenCalledOnce()
})
