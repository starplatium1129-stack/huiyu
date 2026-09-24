import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import ImageSplitCompare from './ImageSplitCompare.vue'

describe('ImageSplitCompare', () => {
  it('puts slider semantics on the focusable comparison container', async () => {
    const wrapper = mount(ImageSplitCompare, {
      props: {
        beforeSrc: '/before.png',
        afterSrc: '/after.png',
        initialPos: 35,
      },
    })

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
  })

  it('supports boundary and page keys while keeping the value text synchronized', async () => {
    const wrapper = mount(ImageSplitCompare, {
      props: {
        beforeSrc: '/before.png',
        afterSrc: '/after.png',
        initialPos: 50,
      },
    })
    const slider = wrapper.find('.image-split-compare')

    await slider.trigger('keydown', { key: 'PageUp' })
    expect(slider.attributes('aria-valuenow')).toBe('60')
    await slider.trigger('keydown', { key: 'PageDown' })
    expect(slider.attributes('aria-valuenow')).toBe('50')
    await slider.trigger('keydown', { key: 'Home' })
    expect(slider.attributes('aria-valuenow')).toBe('0')
    await slider.trigger('keydown', { key: 'End' })
    expect(slider.attributes('aria-valuenow')).toBe('100')

    await slider.trigger('keydown', { key: 'ArrowRight' })
    expect(slider.attributes('aria-valuenow')).toBe('100')
    await slider.trigger('keydown', { key: 'ArrowLeft' })
    expect(slider.attributes('aria-valuenow')).toBe('99')
  })
})
