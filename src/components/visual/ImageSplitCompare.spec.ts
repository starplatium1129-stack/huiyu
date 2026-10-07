import { describe, expect, it, vi } from 'vitest'
import { mount, type DOMWrapper } from '@vue/test-utils'
import ImageSplitCompare from './ImageSplitCompare.vue'
import ImageCompareSlider from './ImageCompareSlider.vue'

async function checkPointerInput(slider: Pick<DOMWrapper<Element>, 'element' | 'trigger' | 'attributes'>) {
  const element = slider.element as HTMLElement
  const captured = new Set<number>()
  element.setPointerCapture = vi.fn(id => { captured.add(id) })
  element.hasPointerCapture = id => captured.has(id)
  element.releasePointerCapture = vi.fn(id => { captured.delete(id) })
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 0, 200, 100))
  const initial = slider.attributes('aria-valuenow')
  await slider.trigger('pointerdown', { pointerId: 1, button: 2, clientX: 170 })
  expect(slider.attributes('aria-valuenow')).toBe(initial)
  expect(document.activeElement).not.toBe(element)
  expect(element.setPointerCapture).not.toHaveBeenCalled()

  await slider.trigger('pointerdown', { pointerId: 1, button: 0, clientX: 170 })
  expect(slider.attributes('aria-valuenow')).toBe('80')
  expect(document.activeElement).toBe(element)
  await slider.trigger('pointermove', { pointerId: 1, clientX: 250 })
  expect(slider.attributes('aria-valuenow')).toBe('100')
  await slider.trigger('pointerup', { pointerId: 1, button: 0 })
  expect(element.releasePointerCapture).toHaveBeenCalledWith(1)
  await slider.trigger('pointermove', { pointerId: 1, clientX: 10 })
  expect(slider.attributes('aria-valuenow')).toBe('100')
}

describe('ImageSplitCompare', () => {
  it('puts slider semantics on the focusable comparison container', async () => {
    const wrapper = mount(ImageSplitCompare, {
      attachTo: document.body,
      props: {
        beforeSrc: '/before.png',
        afterSrc: '/after.png',
        initialPos: 35,
      },
    })

    try {
      const slider = wrapper.find('.image-split-compare')
      const divider = wrapper.find('.split-divider')
      expect(slider.attributes('role')).toBe('slider')
      expect(slider.attributes('tabindex')).toBe('0')
      expect(slider.attributes('aria-label')).toBe('左右对比滑动条：原图与换装后')
      expect(slider.attributes('aria-valuenow')).toBe('35')
      expect(slider.attributes('aria-valuetext')).toBe('对比位置 35%：原图与换装后')
      expect(divider.attributes('role')).toBeUndefined()
      expect(divider.attributes('aria-hidden')).toBe('true')

      await slider.trigger('keydown', { key: 'ArrowRight' })
      expect(slider.attributes('aria-valuenow')).toBe('36')
      expect(slider.attributes('aria-valuetext')).toBe('对比位置 36%：原图与换装后')
      expect(divider.attributes('style')).toContain('--split-pos: 36%')
      await slider.trigger('keydown', { key: 'PageUp' })
      expect(slider.attributes('aria-valuenow')).toBe('46')
      await slider.trigger('keydown', { key: 'PageDown' })
      expect(slider.attributes('aria-valuenow')).toBe('36')
      await slider.trigger('keydown', { key: 'Home' })
      expect(slider.attributes('aria-valuenow')).toBe('0')
      await slider.trigger('keydown', { key: 'End' })
      expect(slider.attributes('aria-valuenow')).toBe('100')

      await slider.trigger('keydown', { key: 'ArrowRight' })
      expect(slider.attributes('aria-valuenow')).toBe('100')
      await slider.trigger('keydown', { key: 'ArrowLeft' })
      expect(slider.attributes('aria-valuenow')).toBe('99')
      await checkPointerInput(slider)
    } finally { wrapper.unmount() }
  })


})

describe('ImageCompareSlider', () => {
  it('keeps accessible values and painted split positions synchronized with keyboard input', async () => {
    const wrapper = mount(ImageCompareSlider, {
      attachTo: document.body,
      props: { beforeSrc: '/before.png', afterSrc: '/after.png', initialRatio: 0.6 },
    })
    try {
      const slider = wrapper.get('[role="slider"]')
      expect(slider.attributes('aria-valuenow')).toBe('60')
      expect(slider.attributes('style')).toContain('--split-pos: 60%')
      expect(slider.attributes('style')).toContain('--split-x: 60cqw')
      expect(slider.attributes('style')).toContain('--clip-pos: 40%')
      await slider.trigger('keydown', { key: 'ArrowLeft' })
      expect(slider.attributes('aria-valuenow')).toBe('59')
      expect(slider.attributes('style')).toContain('--split-x: 59cqw')
      await slider.trigger('keydown', { key: 'ArrowRight' })
      await slider.trigger('keydown', { key: 'ArrowRight' })
      expect(slider.attributes('aria-valuenow')).toBe('61')
      expect(slider.attributes('style')).toContain('--split-x: 61cqw')
      await slider.trigger('keydown', { key: 'PageUp' })
      expect(slider.attributes('aria-valuenow')).toBe('71')
      await slider.trigger('keydown', { key: 'PageDown' })
      expect(slider.attributes('aria-valuenow')).toBe('61')
      await slider.trigger('keydown', { key: 'Home' })
      expect(slider.attributes('aria-valuenow')).toBe('0')
      expect(slider.attributes('style')).toContain('--clip-pos: 100%')
      await slider.trigger('keydown', { key: 'End' })
      expect(slider.attributes('aria-valuenow')).toBe('100')
      expect(slider.attributes('style')).toContain('--clip-pos: 0%')
      await checkPointerInput(slider)
    } finally { wrapper.unmount() }
  })
})
