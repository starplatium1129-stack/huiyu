import { beforeEach, expect, it, vi } from 'vitest'
import { defineComponent, h, KeepAlive, nextTick, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { useDirectorLayout } from './useDirectorLayout'
import { DIRECTOR_LAYOUT_KEY } from '@/utils/storageKeys'

beforeEach(() => {
  localStorage.removeItem(DIRECTOR_LAYOUT_KEY)
  vi.stubGlobal('ResizeObserver', class { observe() {}; disconnect() {} })
  vi.stubGlobal('innerWidth', 1920)
})
function setup(width = 1800) {
  let api!: ReturnType<typeof useDirectorLayout>
  const root = ref<HTMLElement | null>(null)
  const wrapper = mount(defineComponent({ setup() {
    api = useDirectorLayout(root)
    return () => h('div', { ref: (element) => {
      root.value = element as HTMLElement | null
      if (root.value) Object.defineProperty(root.value, 'clientWidth', { configurable: true, get: () => width })
    } })
  } }), { attachTo: document.body })
  return { api, wrapper }
}
it('persists independent rail visibility and widths, and clamps restored widths to a narrow desktop', () => {
  const first = setup()
  first.api.key('materials', new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true }))
  first.api.toggle('inspector')
  const chosenWidth = first.api.materialsWidth.value
  expect(first.api.collapsed.value).toEqual({ materials: false, inspector: true })
  first.wrapper.unmount()
  const reopened = setup()
  expect(reopened.api.materialsWidth.value).toBe(chosenWidth)
  expect(reopened.api.collapsed.value.inspector).toBe(true)
  reopened.wrapper.unmount()
  localStorage.setItem(DIRECTOR_LAYOUT_KEY, JSON.stringify({ materials: 550, inspector: 550 }))
  const narrow = setup(960)
  expect(narrow.api.materialsWidth.value + narrow.api.inspectorWidth.value + 320 + 32).toBeLessThanOrEqual(960)
  narrow.api.reset()
  expect(narrow.api.collapsed.value).toEqual({ materials: false, inspector: false })
  narrow.wrapper.unmount()
})
it('tracks pointer motion directly and releases captured input on disposal', () => {
  const { api, wrapper } = setup()
  const target = document.createElement('div')
  target.setPointerCapture = vi.fn()
  target.hasPointerCapture = vi.fn(() => true)
  target.releasePointerCapture = vi.fn()
  api.start('inspector', { button: 0, isPrimary: true, currentTarget: target, pointerId: 7, clientX: 100, preventDefault: vi.fn() } as unknown as PointerEvent)
  const before = api.inspectorWidth.value
  api.move({ pointerId: 7, clientX: 70 } as PointerEvent)
  expect(api.inspectorWidth.value).toBe(before + 30)
  wrapper.unmount()
  expect(target.releasePointerCapture).toHaveBeenCalledWith(7)
  expect(api.dragging.value).toBe(null)
  const saved = JSON.parse(localStorage.getItem(DIRECTOR_LAYOUT_KEY)!)
  expect(saved.inspector).toBe(before + 30)
})


it('pauses cached layout observation and refreshes geometry and preferences once on return', async () => {
  const measure = vi.fn(() => 1800), observe = vi.fn(), disconnect = vi.fn()
  let resize!: ResizeObserverCallback
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { resize = callback }
    observe = observe
    disconnect = disconnect
  })
  let api!: ReturnType<typeof useDirectorLayout>
  const visible = ref(true)
  const Child = defineComponent({ setup() {
    const root = ref<HTMLElement | null>(null)
    api = useDirectorLayout(root)
    return () => h('div', { ref: (element) => {
      root.value = element as HTMLElement | null
      if (root.value) Object.defineProperty(root.value, 'clientWidth', { configurable: true, get: measure })
    } })
  } })
  const wrapper = mount(defineComponent({ setup: () => () => h(KeepAlive, null, { default: () => visible.value ? h(Child) : null }) }), { attachTo: document.body })
  await nextTick()
  const reads = measure.mock.calls.length
  visible.value = false; await nextTick()
  expect(disconnect).toHaveBeenCalled()
  window.dispatchEvent(new Event('resize'))
  resize([], {} as ResizeObserver)
  expect(measure).toHaveBeenCalledTimes(reads)
  localStorage.setItem(DIRECTOR_LAYOUT_KEY, JSON.stringify({ hideInspector: true }))
  measure.mockReturnValue(960)
  visible.value = true; await nextTick()
  expect(api.collapsed.value.inspector).toBe(true)
  expect(measure.mock.calls.length).toBeGreaterThan(reads)
  const beforeResize = measure.mock.calls.length
  window.dispatchEvent(new Event('resize'))
  expect(measure).toHaveBeenCalledTimes(beforeResize + 1)
  wrapper.unmount()
  resize([], {} as ResizeObserver)
  window.dispatchEvent(new Event('resize'))
  expect(measure).toHaveBeenCalledTimes(beforeResize + 1)
})
