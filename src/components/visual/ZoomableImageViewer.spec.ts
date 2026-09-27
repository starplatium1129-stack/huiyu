import { afterEach, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ZoomableImageViewer from './ZoomableImageViewer.vue'

let wrapper: VueWrapper | undefined
afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.restoreAllMocks() })
function preview() {
  wrapper = mount(ZoomableImageViewer, { props: { src: '/original.jpg', previewSrc: '/thumb.jpg', alt: 'preview' } })
  return wrapper
}

it('shows the known thumbnail immediately without a skeleton or loading fade', () => {
  const view = preview()
  expect(view.find('.skeleton-placeholder').exists()).toBe(false)
  expect(view.get('.zoomable-img').attributes('src')).toBe('/thumb.jpg')
  expect(view.get('.zoomable-img').classes()).toContain('is-ready')
  expect(view.get('.zoomable-preload').attributes('src')).toBe('/original.jpg')
})

it('keeps the thumbnail until the original has decoded and retains the visible image node', async () => {
  const view = preview(), visible = view.get('.zoomable-img').element
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
