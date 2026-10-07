import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import CgImageReveal from './CgImageReveal.vue'
import { startImageDevelopmentReveal } from '@/utils/imageDevelopmentReveal'

vi.mock('@/composables/useVisualActivity', () => ({ useVisualActivity: () => ({ canAnimate: ref(true), lowEffects: ref(false) }) }))
vi.mock('@/utils/imageDevelopmentReveal', () => ({ startImageDevelopmentReveal: vi.fn() }))

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
    await wrapper.setProps({ src: '' })
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.find('canvas').exists()).toBe(false)
  })
})

it('reuses the supplied particle surface after decoding and stops it on unmount', async () => {
  let finish!: () => void
  const stop = vi.fn(() => finish())
  const effect = { stop, finished: new Promise<void>(resolve => { finish = resolve }) }
  const revealEffect = vi.fn(() => effect)
  const wrapper = mount(CgImageReveal, { props: { src: '/canvas-result.png', revealEffect } })
  try {
    const img = wrapper.get('img')
    Object.defineProperties(img.element, {
      complete: { value: true }, naturalWidth: { value: 320 }, naturalHeight: { value: 240 }, animate: { value: vi.fn() },
    })
    await img.trigger('load')
    expect(revealEffect).toHaveBeenCalledExactlyOnceWith(img.element)
    expect(startImageDevelopmentReveal).not.toHaveBeenCalled()
    expect(wrapper.emitted('reveal-start')).toHaveLength(1)
    wrapper.unmount()
    await effect.finished
    expect(stop).toHaveBeenCalledOnce()
    expect(wrapper.emitted('reveal-complete')).toBeUndefined()
  } finally { wrapper.unmount() }
})
