import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

function readingPosition(initial = 640) {
  const original = Object.getOwnPropertyDescriptor(window, 'scrollY')
  let y = initial
  const frames: FrameRequestCallback[] = []
  Object.defineProperty(window, 'scrollY', { configurable: true, get: () => y })
  const scroll = vi.spyOn(window, 'scrollTo').mockImplementation((options: ScrollToOptions | number, top?: number) => { y = typeof options === 'number' ? top! : options.top! })
  const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frames.push(callback); return frames.length })
  return {
    get y() { return y }, set y(value: number) { y = value }, scroll,
    paint() { const callbacks = frames.splice(0); callbacks.forEach(callback => callback(0)); return y },
    restore() { raf.mockRestore(); scroll.mockRestore(); if (original) Object.defineProperty(window, 'scrollY', original) },
  }
}

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
    window.scrollTo = vi.fn((options: ScrollToOptions) => { scrollY = options.top! }) as typeof window.scrollTo
    try {
      vm.open(null)
      scrollY = 0
      vm.close()
      flushNativeClose(dialog)
      expect(scrollY).toBe(420)
      expect(window.scrollTo).toHaveBeenCalledWith({left:0,top:420,behavior:'instant'})
    } finally {
      window.scrollTo = originalScrollTo
      if (originalScrollY) Object.defineProperty(window, 'scrollY', originalScrollY)
    }
  })
  it('captures the reading position before native showModal moves focus', () => {
    const vm = spawn(), dialog = dialogOf(vm)
    const original = Object.getOwnPropertyDescriptor(window, 'scrollY')
    let y = 640
    Object.defineProperty(window, 'scrollY', {configurable:true,get:()=>y})
    const scroll = vi.spyOn(window, 'scrollTo').mockImplementation((options: ScrollToOptions | number, top?: number) => { y = typeof options === 'number' ? top! : options.top! })
    const show = dialog.showModal.bind(dialog)
    vi.spyOn(dialog, 'showModal').mockImplementation(() => { show(); y = 0 })
    try {
      vm.open(null)
      expect(y).toBe(640)
      vm.close(); flushNativeClose(dialog)
      expect(y).toBe(640)
    } finally { scroll.mockRestore(); if(original) Object.defineProperty(window,'scrollY',original) }
  })
  it('cancels pending native smooth scrolling even before the coordinates move', () => {
    const vm = spawn()
    const scroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    try {
      vm.open(null)
      expect(scroll).toHaveBeenCalledWith({ left: window.scrollX, top: window.scrollY, behavior: 'instant' })
    } finally { scroll.mockRestore() }
  })
  it('restores native close scroll and focus before a deferred close event can expose a frame', () => {
    const vm = spawn(), dialog = dialogOf(vm)
    const trigger = document.createElement('button')
    document.body.append(trigger)
    const original = Object.getOwnPropertyDescriptor(window, 'scrollY')
    let y = 640
    const frames: FrameRequestCallback[] = []
    const visibleFrames: number[] = []
    Object.defineProperty(window, 'scrollY', { configurable: true, get: () => y })
    const scroll = vi.spyOn(window, 'scrollTo').mockImplementation((options: ScrollToOptions | number, top?: number) => { y = typeof options === 'number' ? top! : options.top! })
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frames.push(callback); return frames.length })
    const focus = vi.spyOn(trigger, 'focus')
    vi.spyOn(dialog, 'close').mockImplementation(() => {
      dialog.removeAttribute('open'); y = 0
      requestAnimationFrame(() => flushNativeClose(dialog))
    })
    try {
      vm.open(trigger); focus.mockClear()
      vm.close()
      visibleFrames.push(y)
      const focusedBeforeFrame = focus.mock.calls.some(([options]) => options?.preventScroll)
      for (let tick = 0; frames.length && tick < 5; tick++) {
        const callbacks = frames.splice(0)
        callbacks.forEach(callback => callback(tick))
        visibleFrames.push(y)
      }
      expect(visibleFrames.every(top => top === 640)).toBe(true)
      expect(focusedBeforeFrame).toBe(true)
    } finally {
      trigger.remove(); raf.mockRestore(); scroll.mockRestore(); focus.mockRestore()
      if (original) Object.defineProperty(window, 'scrollY', original)
    }
  })
  it('does not let an old deferred restore move a newly opened modal', () => {
    const first = spawn(), second = spawn()
    const frames:FrameRequestCallback[] = []
    const raf = vi.spyOn(window,'requestAnimationFrame').mockImplementation(callback=>{frames.push(callback);return frames.length})
    const scroll = vi.spyOn(window,'scrollTo').mockImplementation(()=>{})
    const original = Object.getOwnPropertyDescriptor(window,'scrollY')
    let y = 320
    Object.defineProperty(window,'scrollY',{configurable:true,get:()=>y})
    try {
      first.open(null); first.close(); flushNativeClose(dialogOf(first))
      y = 780; second.open(null); scroll.mockClear(); y = 0
      for(let count=0;frames.length&&count<10;count++) frames.shift()!(count)
      expect(scroll).not.toHaveBeenCalled()
      second.close();flushNativeClose(dialogOf(second))
    } finally {raf.mockRestore();scroll.mockRestore();if(original)Object.defineProperty(window,'scrollY',original)}
  })
  it('cancels a native close smooth scroll that has not moved yet', () => {
    const vm = spawn(), dialog = dialogOf(vm), reading = readingPosition()
    let pending = false
    const close = vi.spyOn(dialog, 'close').mockImplementation(() => {
      dialog.removeAttribute('open'); pending = true
      requestAnimationFrame(() => { if (pending) reading.y = 0; flushNativeClose(dialog) })
    })
    reading.scroll.mockImplementation((options: ScrollToOptions | number, top?: number) => {
      pending = false; reading.y = typeof options === 'number' ? top! : options.top!
    })
    try {
      vm.open(null); reading.scroll.mockClear(); vm.close()
      expect(reading.scroll).toHaveBeenCalledWith({ left: 0, top: 640, behavior: 'instant' })
      expect(pending).toBe(false)
      expect([reading.y, reading.paint(), reading.paint()]).toEqual([640, 640, 640])
    } finally { close.mockRestore(); reading.restore() }
  })

  it('corrects a nested native close without releasing the remaining modal lock', () => {
    const first = spawn(), second = spawn(), reading = readingPosition()
    const inner = dialogOf(second)
    const close = vi.spyOn(inner, 'close').mockImplementation(() => { inner.removeAttribute('open'); reading.y = 0 })
    try {
      first.open(null); second.open(null); second.close()
      expect(overflow()).toBe('hidden')
      expect(reading.y).toBe(640)
      first.close(); expect(overflow()).toBe('')
      flushNativeClose(inner)
      expect(reading.y).toBe(640)
    } finally { close.mockRestore(); reading.restore() }
  })

  it('settles native scroll after dispose closes the dialog, without focusing an old trigger', () => {
    const vm = spawn(), dialog = dialogOf(vm), reading = readingPosition()
    const trigger = document.createElement('button'); document.body.append(trigger)
    const focus = vi.spyOn(trigger, 'focus')
    const close = vi.spyOn(dialog, 'close').mockImplementation(() => { dialog.removeAttribute('open'); reading.y = 0 })
    try {
      vm.open(trigger); focus.mockClear(); vm.dispose()
      expect(reading.y).toBe(640)
      expect(focus).not.toHaveBeenCalled()
      expect(overflow()).toBe('')
    } finally { close.mockRestore(); focus.mockRestore(); trigger.remove(); reading.restore() }
  })

  it.each(['/gallery', '/showcase?tab=other', '/showcase#/gallery'])('does not restore a closed route after navigation to %s', target => {
    const previous = window.location.href
    history.replaceState(null, '', '/showcase#/showcase')
    const vm = spawn(), dialog = dialogOf(vm), reading = readingPosition()
    try {
      vm.open(null); vm.close(); reading.scroll.mockClear()
      history.replaceState(null, '', target); reading.y = 80
      flushNativeClose(dialog)
      reading.paint(); reading.paint()
      expect(reading.y).toBe(80)
      expect(reading.scroll).not.toHaveBeenCalled()
    } finally { reading.restore(); history.replaceState(null, '', previous) }
  })
})

describe('isBackdropClick predicate', () => {

  it('distinguishes backdrop coordinates from panel padding and child clicks', () => {
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
    const child = document.createElement('div')
    dialog.appendChild(child)
    expect(isBackdropClick({ target: child, clientX: 10, clientY: 10 } as unknown as MouseEvent, dialog)).toBe(false)
    expect(isBackdropClick({ target: dialog, clientX: 120, clientY: 120 } as unknown as MouseEvent, dialog)).toBe(false)
    // Click at (10, 10), outside the dialog rectangle
    const backdropEvent = { target: dialog, clientX: 10, clientY: 10 } as unknown as MouseEvent
    expect(isBackdropClick(backdropEvent, dialog)).toBe(true)
  })
})
