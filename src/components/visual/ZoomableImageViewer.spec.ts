import { afterEach, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ZoomableImageViewer from './ZoomableImageViewer.vue'

let wrapper: VueWrapper | undefined
afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.restoreAllMocks() })
function preview() {
  wrapper = mount(ZoomableImageViewer, { props: { src: '/original.jpg', previewSrc: '/thumb.jpg', alt: 'preview' } })
  return wrapper
}

it('keeps the thumbnail until the original has decoded and retains the visible image node', async () => {
  const view = preview(), visible = view.get('.zoomable-img').element
  expect(view.find('.skeleton-placeholder').exists()).toBe(false)
  expect(view.get('.zoomable-img').attributes('src')).toBe('/thumb.jpg')
  expect(view.get('.zoomable-img').classes()).toContain('is-ready')
  expect(view.get('.zoomable-preload').attributes('src')).toBe('/original.jpg')
  const original = view.get('.zoomable-preload').element as HTMLImageElement
  let decoded!: () => void
  original.decode = vi.fn(() => new Promise<void>(resolve => { decoded = resolve }))
  await view.get('.zoomable-preload').trigger('load')
  expect(view.get('.zoomable-img').attributes('src')).toBe('/thumb.jpg')
  decoded(); await flushPromises()
  expect(view.get('.zoomable-img').element).toBe(visible)
  expect(view.get('.zoomable-img').attributes('src')).toBe('/original.jpg')
  expect(view.get('.zoomable-img').classes()).toContain('is-ready')
  expect(view.find('.skeleton-placeholder').exists()).toBe(false)
})

it('ignores an old decode after switching pictures', async () => {
  const view = preview(), original = view.get('.zoomable-preload').element as HTMLImageElement
  let decoded!: () => void
  original.decode = vi.fn(() => new Promise<void>(resolve => { decoded = resolve }))
  await view.get('.zoomable-preload').trigger('load')
  await view.setProps({ src: '/next.jpg', previewSrc: '/next-thumb.jpg' })
  decoded(); await flushPromises()
  expect(view.get('.zoomable-img').attributes('src')).toBe('/next-thumb.jpg')
  expect(view.get('.zoomable-preload').attributes('src')).toBe('/next.jpg')
})

it('keeps an available thumbnail with a truthful status when the original fails', async () => {
  const view = preview()
  await view.get('.zoomable-preload').trigger('error')
  expect(view.get('.zoomable-img').attributes('src')).toBe('/thumb.jpg')
  expect(view.get('[role="status"]').text()).toContain('当前显示缩略图')
  expect(view.find('.image-fallback').exists()).toBe(false)
  expect(view.emitted('error')).toHaveLength(1)
})

it('zooms around the wheel position and responds to keyboard zoom without handling child controls', async () => {
  const view = preview(), viewport = view.get('.zoom-viewport').element
  expect(view.attributes('tabindex')).toBe('0')
  const controls = view.findAll('.zoom-control')
  expect(controls.map(control => control.attributes('aria-label'))).toEqual(['放大图片', '缩小图片', '还原图片缩放'])
  vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 200, height: 200 } as DOMRect)
  await view.trigger('wheel', { deltaY: -1, clientX: 150, clientY: 100 })
  expect(view.get('.zoom-transform-layer').attributes('style')).toContain('translate(-12.5px, 0px) scale(1.25)')
  await view.trigger('keydown', { key: '+' })
  expect(view.get('.zoom-level').text()).toBe('150%')
  await view.get('[aria-label="放大图片"]').trigger('keydown', { key: 'Home' })
  expect(view.get('.zoom-level').text()).toBe('150%')
  await view.trigger('keydown', { key: 'Home' })
  expect(view.get('.zoom-level').text()).toBe('100%')
  await controls[0].trigger('click')
  expect(view.get('.zoom-level').text()).toBe('125%')
  await controls[1].trigger('click')
  expect(view.get('.zoom-level').text()).toBe('100%')
  await controls[0].trigger('click')
  await view.trigger('keydown', { key: 'ArrowRight' })
  expect(view.get('.zoom-transform-layer').attributes('style')).toContain('translate(32px, 0px) scale(1.25)')
  await view.trigger('keydown', { key: 'Home' })
  expect(view.get('.zoom-transform-layer').attributes('style')).toContain('translate(0px, 0px) scale(1)')
})

it('keeps one pointer in control and releases it when the picture changes', async () => {
  const view = preview(), element = view.element as HTMLElement
  element.setPointerCapture = vi.fn()
  element.releasePointerCapture = vi.fn()
  await view.get('[aria-label="放大图片"]').trigger('click')
  await view.trigger('pointerdown', { pointerId: 1, button: 0, clientX: 20, clientY: 20 })
  await view.trigger('pointerdown', { pointerId: 2, button: 0, clientX: 100, clientY: 100 })
  await view.trigger('pointermove', { pointerId: 2, clientX: 200, clientY: 200 })
  await view.trigger('pointermove', { pointerId: 1, clientX: 35, clientY: 30 })
  expect(view.get('.zoom-transform-layer').attributes('style')).toContain('translate(15px, 10px) scale(1.25)')
  expect(element.setPointerCapture).toHaveBeenCalledExactlyOnceWith(1)
  await view.setProps({ src: '/next.jpg', previewSrc: '/next-thumb.jpg' })
  expect(element.releasePointerCapture).toHaveBeenCalledExactlyOnceWith(1)
  expect(view.get('.zoom-level').text()).toBe('100%')
  expect(view.classes()).not.toContain('is-panning')
})
