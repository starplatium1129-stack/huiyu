import { afterEach, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import { useGalleryCoverFlow } from './useGalleryCoverFlow'

const cleanups: Array<() => void> = []
afterEach(() => {
  cleanups.splice(0).forEach(cleanup => cleanup())
  delete document.documentElement.dataset.motion
  vi.useRealTimers(); vi.restoreAllMocks()
})
async function fixture() {
  const index = ref(2), active = ref(true), select = vi.fn((value: number) => { index.value = value })
  let flow!: ReturnType<typeof useGalleryCoverFlow>
  const wrapper = mount(defineComponent({ setup() {
    const host = ref<HTMLElement | null>(null)
    flow = useGalleryCoverFlow(host, { index: () => index.value, count: () => 8, active: () => active.value, select })
    return () => h('div', { ref: host, tabindex: 0 }, h('div', { class: 'zoomable-image-viewer is-zoomed' }))
  } }), { attachTo: document.body })
  const element = wrapper.element as HTMLElement
  element.setPointerCapture = vi.fn(); element.hasPointerCapture = () => true; element.releasePointerCapture = vi.fn()
  cleanups.push(() => wrapper.unmount())
  await nextTick()
  return { wrapper, element, index, active, select, flow }
}
function pointer(element: HTMLElement, type: string, x: number, time: number) {
  const event = new PointerEvent(type, { pointerId: 1, button: 0, clientX: x, bubbles: true, cancelable: true })
  Object.defineProperty(event, 'timeStamp', { value: time })
  element.dispatchEvent(event)
}
it('tracks a drag immediately, commits once on release and discards a gesture after closing', async () => {
  const { element, select, flow, active } = await fixture()
  pointer(element, 'pointerdown', 400, 0)
  pointer(element, 'pointermove', 256, 130)
  expect(flow.position.value).toBe(3)
  expect(flow.dragging.value).toBe(true)
  expect(select).not.toHaveBeenCalled()
  pointer(element, 'pointerup', 256, 260)
  expect(select).toHaveBeenCalledExactlyOnceWith(3)
  expect(flow.dragging.value).toBe(false)
  pointer(element, 'pointerdown', 400, 300)
  pointer(element, 'pointermove', 256, 430)
  active.value = false; await nextTick()
  pointer(element, 'pointerup', 256, 560)
  expect(select).toHaveBeenCalledTimes(1)
  expect(flow.dragging.value).toBe(false)
})
it('keeps zoom gestures with the image and settles bounded selection under reduced motion', async () => {
  vi.useFakeTimers()
  const { wrapper, element, select, flow, index } = await fixture()
  const zoom = wrapper.get('.is-zoomed').element
  const zoomWheel = new WheelEvent('wheel', { deltaY: 160, bubbles: true, cancelable: true })
  zoom.dispatchEvent(zoomWheel)
  expect(zoomWheel.defaultPrevented).toBe(false)
  expect(select).not.toHaveBeenCalled()
  element.dispatchEvent(new WheelEvent('wheel', { deltaY: 160, bubbles: true, cancelable: true }))
  expect(index.value).toBe(3)
  document.documentElement.dataset.motion = 'reduce'
  window.dispatchEvent(new Event('atelier:motion-preference'))
  expect(flow.position.value).toBe(3)
  flow.select(99); await nextTick()
  expect(index.value).toBe(7)
  expect(flow.position.value).toBe(7)
  wrapper.unmount(); vi.advanceTimersByTime(500)
  expect(select.mock.calls).toEqual([[3], [7]])
})
