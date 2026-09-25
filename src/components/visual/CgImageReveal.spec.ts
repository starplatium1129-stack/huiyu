import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import CgImageReveal from './CgImageReveal.vue'

describe('CgImageReveal component', () => {
  it('renders target image element and hidden decorative canvas', () => {
    const wrapper = mount(CgImageReveal, {
      props: {
        src: '/test-cg.png',
        alt: '测试成片',
        imgClass: 'custom-cg-class',
      },
    })

    const img = wrapper.find('img.cg-image-target')
    expect(img.exists()).toBe(true)
    expect(img.attributes('src')).toBe('/test-cg.png')
    expect(img.attributes('alt')).toBe('测试成片')
    expect(img.classes()).toContain('custom-cg-class')

    const canvas = wrapper.find('canvas.cg-reveal-canvas')
    expect(canvas.exists()).toBe(true)
    expect(canvas.attributes('aria-hidden')).toBe('true')
  })

  it('emits click event when image is clicked', async () => {
    const wrapper = mount(CgImageReveal, {
      props: {
        src: '/test-cg.png',
      },
    })

    await wrapper.find('img.cg-image-target').trigger('click')
    expect(wrapper.emitted('click')).toHaveLength(1)
  })

  it('handles image error and stops revealing gracefully', async () => {
    const wrapper = mount(CgImageReveal, {
      props: {
        src: '/invalid.png',
      },
    })

    await wrapper.find('img.cg-image-target').trigger('error')
    expect(wrapper.emitted('error')).toHaveLength(1)
    expect(wrapper.classes()).toContain('is-loaded')
  })

  it('exposes triggerReveal method', () => {
    const wrapper = mount(CgImageReveal, {
      props: {
        src: '/test-cg.png',
        autoReveal: false,
      },
    })

    expect(typeof wrapper.vm.triggerReveal).toBe('function')
  })
})
