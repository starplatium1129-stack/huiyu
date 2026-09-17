import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import { useFluidDialog, isBackdropClick } from './useFluidDialog'

/**
 * 模态弹窗的页面滚动锁定向回归。
 *
 * 浏览器把 `dialog.close()` 的 close 事件排在任务队列末尾派发，因此
 * `close(() => open())` 这类同轮重开会在事件到达前重新 showModal。
 * 本文件的用例手动派发同一事件来复现这个时序（不同 DOM 实现的原生派发时机不一致，
 * 手动派发才能得到确定性的断言），并覆盖正常关闭、嵌套与卸载。
 */

const Harness = defineComponent({
  name: 'FluidDialogHarness',
  setup(_, { expose }) {
    const el = ref<HTMLDialogElement | null>(null)
    const motion = useFluidDialog(el)
    expose({ el, ...motion })
    return () => h('dialog', { ref: el, class: 'fluid-dialog-probe' }, [h('input')])
  },
})

type HarnessVm = { el: HTMLDialogElement | null; open: (source?: HTMLElement | null) => void; close: (after?: () => void) => void; dispose: () => void }

let mounted: VueWrapper[] = []
function spawn(): HarnessVm {
  const wrapper = mount(Harness, { attachTo: document.body })
  mounted.push(wrapper)
  return wrapper.vm as unknown as HarnessVm
}
const dialogOf = (vm: HarnessVm) => vm.el as HTMLDialogElement
const overflow = () => document.documentElement.style.overflow
/** 复现「原生 close 事件在任务队列末尾派发」：重开之后再让旧事件到达。 */
const flushNativeClose = (dialog: HTMLDialogElement) => dialog.dispatchEvent(new Event('close'))

describe('modal page scroll lock', () => {
  beforeEach(() => {
    document.documentElement.dataset.motion = 'reduce'
    document.documentElement.style.overflow = ''
    document.documentElement.style.paddingRight = ''
  })
  afterEach(() => {
    mounted.forEach(wrapper => wrapper.unmount())
    mounted = []
    document.documentElement.style.overflow = ''
    document.documentElement.style.paddingRight = ''
    delete document.documentElement.dataset.motion
  })

  it('locks while open and releases after a normal close', () => {
    const vm = spawn(), dialog = dialogOf(vm)
    vm.open(null)
    expect(dialog.open).toBe(true)
    expect(overflow()).toBe('hidden')
    vm.close()
    flushNativeClose(dialog)
    expect(dialog.open).toBe(false)
    expect(overflow()).toBe('')
  })

  it('keeps the lock when the close callback reopens in the same round', () => {
    const vm = spawn(), dialog = dialogOf(vm)
    vm.open(null)
    expect(overflow()).toBe('hidden')
    // 关闭动画结束时立刻重开，随后旧 dialog 的 close 事件才到达。
    vm.close(() => vm.open(null))
    expect(dialog.open).toBe(true)
    flushNativeClose(dialog)
    expect(dialog.open, '重开后弹窗应保持打开').toBe(true)
    expect(overflow(), '重开后仍须锁定背景滚动').toBe('hidden')
    // 只有最终关闭才解锁。
    vm.close()
    flushNativeClose(dialog)
    expect(dialog.open).toBe(false)
    expect(overflow()).toBe('')
  })

  it('counts nested dialogs and only releases after the last one closes', () => {
    const first = spawn(), second = spawn()
    const firstDialog = dialogOf(first), secondDialog = dialogOf(second)
    first.open(null); second.open(null)
    expect(overflow()).toBe('hidden')

    first.close()
    flushNativeClose(firstDialog)
    expect(firstDialog.open).toBe(false)
    expect(overflow(), '另一个弹窗仍打开时不能解锁').toBe('hidden')

    second.close()
    flushNativeClose(secondDialog)
    expect(secondDialog.open).toBe(false)
    expect(overflow()).toBe('')
  })

  it('releases the lock when the owning component unmounts while open', () => {
    const vm = spawn(), dialog = dialogOf(vm)
    vm.open(null)
    expect(overflow()).toBe('hidden')
    const wrapper = mounted.pop()
    wrapper?.unmount()
    expect(dialog.open).toBe(false)
    expect(overflow()).toBe('')
  })

  it('releases the lock through dispose without needing a close event', () => {
    const vm = spawn(), dialog = dialogOf(vm)
    vm.open(null)
    vm.dispose()
    expect(dialog.open).toBe(false)
    expect(overflow()).toBe('')
  })

  it('restores the page scroll position after closing', () => {
    const vm = spawn(), dialog = dialogOf(vm)
    const originalScrollTo = window.scrollTo
    const originalScrollY = Object.getOwnPropertyDescriptor(window, 'scrollY')
    let scrollY = 420
    Object.defineProperty(window, 'scrollY', { configurable: true, get: () => scrollY })
    window.scrollTo = ((_: number, top: number) => { scrollY = top }) as typeof window.scrollTo
    try {
      vm.open(null)
      scrollY = 0
      vm.close()
      flushNativeClose(dialog)
      expect(scrollY).toBe(420)
    } finally {
      window.scrollTo = originalScrollTo
      if (originalScrollY) Object.defineProperty(window, 'scrollY', originalScrollY)
    }
  })
})

describe('isBackdropClick predicate', () => {
  it('returns false when clicking child elements inside dialog', () => {
    const dialog = document.createElement('dialog')
    const child = document.createElement('div')
    dialog.appendChild(child)
    const event = { target: child, clientX: 100, clientY: 100 } as unknown as MouseEvent
    expect(isBackdropClick(event, dialog)).toBe(false)
  })

  it('returns false when clicking inside dialog bounding box (e.g. padding / empty areas)', () => {
    const dialog = document.createElement('dialog')
    dialog.getBoundingClientRect = () => ({
      left: 100,
      right: 500,
      top: 100,
      bottom: 400,
      width: 400,
      height: 300,
      x: 100,
      y: 100,
      toJSON: () => {},
    })
    // Click within [100, 500] x [100, 400]
    const insideEvent = { target: dialog, clientX: 120, clientY: 120 } as unknown as MouseEvent
    expect(isBackdropClick(insideEvent, dialog)).toBe(false)
  })

  it('returns true when event target is dialog and click coordinates are outside bounding box', () => {
    const dialog = document.createElement('dialog')
    dialog.getBoundingClientRect = () => ({
      left: 100,
      right: 500,
      top: 100,
      bottom: 400,
      width: 400,
      height: 300,
      x: 100,
      y: 100,
      toJSON: () => {},
    })
    // Click at (10, 10), outside the dialog rectangle
    const backdropEvent = { target: dialog, clientX: 10, clientY: 10 } as unknown as MouseEvent
    expect(isBackdropClick(backdropEvent, dialog)).toBe(true)
  })
})
