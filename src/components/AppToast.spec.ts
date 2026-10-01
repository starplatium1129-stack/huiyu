import { afterEach, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import AppToast from './AppToast.vue'
import { useToast } from '@/composables/useToast'
import { animateMini } from 'motion'
vi.mock('motion', () => ({ animateMini: vi.fn(() => Object.assign(Promise.resolve(), { stop: vi.fn() })) }))
vi.mock('@/composables/useInterfaceFeedback', () => ({ playInterfaceTone: vi.fn() }))
afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ''; delete document.documentElement.dataset.motion })

it('resumes expiry when the focused dismiss button is removed', async () => {
  vi.useFakeTimers()
  const wrapper = mount(AppToast, { attachTo: document.body, global: { stubs: { transition: false, 'transition-group': false } } })
  const toast = useToast()
  toast.show('第一条', 'info', 1000)
  await nextTick(); await flushPromises()
  const close = document.querySelector<HTMLButtonElement>('.toast-close')!
  close.focus()
  vi.mocked(animateMini).mockClear()
  close.click()
  await nextTick(); await flushPromises(); await nextTick()
  expect(animateMini).not.toHaveBeenCalled()
  toast.show('第二条', 'info', 1000)
  await nextTick()
  vi.advanceTimersByTime(1001)
  expect(toast.toasts.value).toHaveLength(0)
  wrapper.unmount()
})

it('settles an in-flight toast immediately when the app selects reduced motion', async () => {
  const stop = vi.fn()
  vi.mocked(animateMini).mockImplementationOnce(() => Object.assign(new Promise<void>(() => {}), { stop }) as unknown as ReturnType<typeof animateMini>)
  document.documentElement.dataset.motion = 'full'
  const wrapper = mount(AppToast, { attachTo: document.body, global: { stubs: { transition: false, 'transition-group': false } } })
  const toast = useToast()
  toast.show('切换动态效果', 'info', 10000)
  await nextTick()
  document.documentElement.dataset.motion = 'reduce'
  window.dispatchEvent(new Event('atelier:motion-preference'))
  expect(stop).toHaveBeenCalledOnce()
  expect(document.querySelector<HTMLElement>('.toast-item')?.style.opacity).toBe('1')
  expect(document.querySelector<HTMLElement>('.toast-item')?.style.transform).toBe('')
  toast.toasts.value.forEach(item => toast.dismiss(item.id))
  await nextTick(); await flushPromises()
  wrapper.unmount()
})

it('grabs the current toast pose, pauses expiry and releases only the active pointer', async () => {
  vi.useFakeTimers()
  const stop = vi.fn()
  vi.mocked(animateMini).mockImplementationOnce((target) => {
    const element = target as HTMLElement
    stop.mockImplementation(() => { element.style.opacity = '0.65'; element.style.transform = 'translateY(4px) scale(.98)' })
    return Object.assign(new Promise<void>(() => {}), { stop }) as unknown as ReturnType<typeof animateMini>
  })
  const wrapper = mount(AppToast, { attachTo: document.body, global: { stubs: { transition: false, 'transition-group': false } } })
  const toast = useToast()
  toast.show('拖动时保留这条提示', 'info', 200)
  await nextTick()
  const item = document.querySelector<HTMLElement>('.toast-item')!
  item.setPointerCapture = vi.fn()
  item.releasePointerCapture = vi.fn()
  item.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, button: 0, clientY: 10 }))
  item.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 2, button: 0, clientY: 100 }))
  vi.advanceTimersByTime(1000)
  expect(toast.toasts.value).toHaveLength(1)
  item.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientY: 14 }))
  expect(item.style.transform).toContain('translateY(4px) scale(.98)')
  expect(item.setPointerCapture).toHaveBeenCalledExactlyOnceWith(1)
  item.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 1 }))
  expect(item.releasePointerCapture).toHaveBeenCalledExactlyOnceWith(1)
  expect(stop).toHaveBeenCalledOnce()
  vi.advanceTimersByTime(201)
  await nextTick(); await flushPromises()
  expect(toast.toasts.value).toHaveLength(0)
  wrapper.unmount()
})
