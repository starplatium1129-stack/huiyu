import { afterEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import CgImageReveal from './CgImageReveal.vue'

const cleanup: Array<() => void> = []
afterEach(() => cleanup.splice(0).forEach(unmount => unmount()))
function fixture(props: { src: string; alt?: string; imgClass?: string }) {
  const wrapper = mount(CgImageReveal, { props })
  cleanup.push(() => wrapper.unmount())
  return wrapper
}

describe('CgImageReveal component', () => {
  it('renders the original image and a hidden decorative glow without a canvas', () => {
    const wrapper = fixture({
      src: '/test-cg.png',
      alt: '测试成片',
      imgClass: 'custom-cg-class',
    })

    const img = wrapper.find('img.cg-image-target')
    expect(img.exists()).toBe(true)
    expect(img.attributes('src')).toBe('/test-cg.png')
    expect(img.attributes('alt')).toBe('测试成片')
    expect(img.classes()).toContain('custom-cg-class')

    expect(wrapper.find('canvas').exists()).toBe(false)
    const glow = wrapper.get('.cg-reveal-glow')
    expect(glow.attributes('aria-hidden')).toBe('true')
    expect(glow.attributes('style')).toContain('display: none')
    expect(img.attributes('loading')).toBe('eager')
    expect(img.attributes('decoding')).toBe('async')
  })

  it('emits click event when image is clicked', async () => {
    const wrapper = fixture({ src: '/test-cg.png' })

    await wrapper.find('img.cg-image-target').trigger('click')
    expect(wrapper.emitted('click')).toHaveLength(1)
  })

  it('handles image error and stops revealing gracefully', async () => {
    const wrapper = fixture({ src: '/invalid.png' })

    await wrapper.find('img.cg-image-target').trigger('error')
    expect(wrapper.emitted('error')).toHaveLength(1)
    expect(wrapper.classes()).toContain('is-loaded')
    expect(wrapper.classes()).not.toContain('is-revealing')
  })

  it('does not create an image for an empty source', () => {
    const wrapper = fixture({ src: '' })
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.find('canvas').exists()).toBe(false)
  })
})
