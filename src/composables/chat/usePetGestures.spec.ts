import { describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { usePetGestures } from './usePetGestures'

function setup() {
  const drag = vi.fn().mockResolvedValue(undefined), chat = vi.fn()
  const wrapper = mount(defineComponent({ setup() {
    const gestures = usePetGestures({ startDragging: drag } as unknown as Window['companionDesktop'], chat)
    return () => h('div', { 'data-open': gestures.controlsOpen.value, onContextmenu: gestures.contextMenu, onPointerdownCapture: gestures.beginDrag, onDblclick: gestures.doubleClick }, [h('div', { class: 'portrait-stage' }), h('button', '设置')])
  } }))
  return { wrapper, drag, chat }
}
describe('pure pet gestures', () => {
  it('stays chrome-free on hover and opens controls only explicitly', async () => {
    const { wrapper } = setup()
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 100, clientY: 100 }))
    expect(wrapper.attributes('data-open')).toBe('false')
    await wrapper.trigger('contextmenu')
    expect(wrapper.attributes('data-open')).toBe('true')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(wrapper.attributes('data-open')).toBe('false')
    wrapper.unmount()
  })
  it('starts a native drag only after dragging the model, never from a control', async () => {
    const { wrapper, drag } = setup()
    await wrapper.get('.portrait-stage').trigger('pointerdown', { button: 0, clientX: 10, clientY: 10 })
    window.dispatchEvent(new MouseEvent('pointermove', { buttons: 1, clientX: 13, clientY: 12 }))
    expect(drag).not.toHaveBeenCalled()
    window.dispatchEvent(new MouseEvent('pointermove', { buttons: 1, clientX: 30, clientY: 30 }))
    await flushPromises()
    expect(drag).toHaveBeenCalledTimes(1)
    await wrapper.get('button').trigger('pointerdown', { button: 0, clientX: 10, clientY: 10 })
    window.dispatchEvent(new MouseEvent('pointermove', { buttons: 1, clientX: 80, clientY: 80 }))
    expect(drag).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })
  it('opens chat on model double click but not on controls', async () => {
    const { wrapper, chat } = setup()
    await wrapper.get('.portrait-stage').trigger('dblclick')
    await wrapper.get('button').trigger('dblclick')
    expect(chat).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })
})
