import { afterEach, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import PhotoSwipeStage from './PhotoSwipeStage.vue'

const mocks = vi.hoisted(() => ({ read: vi.fn(), failed: vi.fn(), destroyed: vi.fn() }))
vi.mock('@/composables/useImageStore', () => ({ imgGet: mocks.read }))
vi.mock('photoswipe', () => ({ default: class {
  events: Record<string, (event: unknown) => void> = {}
  currIndex = 0
  on(name: string, callback: (event: unknown) => void) { this.events[name] = callback }
  init() { this.events.contentLoad({ content: { index: 0, onError: mocks.failed }, preventDefault() {} }) }
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
})
