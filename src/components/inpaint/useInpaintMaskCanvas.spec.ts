import { expect, it, vi } from 'vitest'
import { defineComponent, h, KeepAlive, nextTick, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { useInpaintMaskCanvas } from './useInpaintMaskCanvas'
import { MaskTileHistory } from './maskTileHistory'

it('keeps mask undo scoped to active modal controls rather than text edits or another dialog', async () => {
  const undo = vi.spyOn(MaskTileHistory.prototype, 'undo').mockImplementation(() => {})
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ beginPath() {}, arc() {}, fill() {} } as unknown as CanvasRenderingContext2D)
  vi.spyOn(MaskTileHistory.prototype, 'capture').mockImplementation(() => {})
  const remove = vi.spyOn(window, 'removeEventListener')
  const active = ref(true)
  const Panel = defineComponent({ setup() {
    const mask = useInpaintMaskCanvas({ active: () => true, imageEl: ref(null), resolution: () => null })
    mask.maskMode.value = 'paint'
    return () => h('div', { role: 'dialog' }, [h('canvas', { ref: mask.maskCanvasEl, tabindex: 0, onPointerdown: mask.startMaskPaint }), h('button', 'brush'),
      h('textarea'), h('input'), h('div', { contenteditable: '' }, [h('span', 'editable')]),
      h('div', { role: 'alertdialog' }, [h('button', 'confirmation')])])
  } })
  const wrapper = mount(defineComponent({ setup: () => () => h(KeepAlive, null, { default: () => active.value ? h(Panel) : null }) }), { attachTo: document.body })
  const key = (target: Element, options: KeyboardEventInit = {}, prevented = false) => {
    const event = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true, ...options })
    if (prevented) event.preventDefault()
    target.dispatchEvent(event)
    return event
  }
  try {
    for (const target of ['textarea', 'input', '[contenteditable] span', '[role="alertdialog"] button']) {
      expect(key(wrapper.get(target).element).defaultPrevented).toBe(false)
    }
    const brush = wrapper.get('button').element
    for (const options of [{ shiftKey: true }, { altKey: true }, { isComposing: true }]) expect(key(brush, options).defaultPrevented).toBe(false)
    key(brush, {}, true)
    expect(undo).not.toHaveBeenCalled()
    expect(key(brush).defaultPrevented).toBe(true)
    expect(undo).toHaveBeenCalledTimes(1)
    active.value = false; await nextTick()
    expect(remove).toHaveBeenCalledWith('keydown', expect.any(Function))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }))
    expect(undo).toHaveBeenCalledTimes(1)
    active.value = true; await nextTick()
    expect(key(wrapper.get('button').element, { ctrlKey: false, metaKey: true }).defaultPrevented).toBe(true)
    expect(undo).toHaveBeenCalledTimes(2)
    const canvas = wrapper.get('canvas').element
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 300, height: 150 } as DOMRect)
    canvas.setPointerCapture = vi.fn()
    wrapper.get('textarea').element.focus()
    await wrapper.get('canvas').trigger('pointerdown', { pointerId: 1, clientX: 20, clientY: 20 })
    expect(document.activeElement).toBe(canvas)
    expect(key(document.activeElement!).defaultPrevented).toBe(true)
    expect(undo).toHaveBeenCalledTimes(3)
  } finally { wrapper.unmount(); vi.restoreAllMocks() }
})
