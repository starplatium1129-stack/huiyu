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
  it('renders a clickable original image without allocating idle effects', async () => {
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
    expect(img.attributes('loading')).toBe('eager')
    expect(img.attributes('decoding')).toBe('async')
    await img.trigger('click')
    expect(wrapper.emitted('click')).toHaveLength(1)
  })

  it('does not create an image for an empty source', () => {
    const wrapper = fixture({ src: '' })
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.find('canvas').exists()).toBe(false)
  })
})
