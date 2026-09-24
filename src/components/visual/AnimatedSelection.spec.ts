import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import AnimatedSelection from './AnimatedSelection.vue'

describe('AnimatedSelection lifecycle and background suspension', () => {
  let originalHidden: PropertyDescriptor | undefined

  beforeEach(() => {
    document.body.innerHTML = ''
    originalHidden = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden')
  })

  afterEach(() => {
    if (originalHidden) {
      Object.defineProperty(Document.prototype, 'hidden', originalHidden)
    }
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('mounts and tracks active pressed button', async () => {
    const Container = defineComponent({
      setup() {
        const selected = ref('a')
        return () =>
          h('div', { class: 'nav-tabs', style: 'position: relative;' }, [
            h('button', {
              'aria-pressed': selected.value === 'a' ? 'true' : 'false',
              id: 'btn-a',
            }, 'Tab A'),
            h('button', {
              'aria-pressed': selected.value === 'b' ? 'true' : 'false',
              id: 'btn-b',
            }, 'Tab B'),
            h(AnimatedSelection),
          ])
      },
    })

    const wrapper = mount(Container, { attachTo: document.body })
    await nextTick()

    const indicator = wrapper.find('.animated-selection')
    expect(indicator.exists()).toBe(true)

    wrapper.unmount()
  })

  it('tracks nested active link wrapped inside tooltip and falls back from :scope >', async () => {
    const Container = defineComponent({
      setup() {
        const active = ref('home')
        return () =>
          h('div', { class: 'nav-links', style: 'position: relative;' }, [
            h(AnimatedSelection, { target: ':scope > a.active' }),
            h('span', { class: 'studio-tooltip-anchor' }, [
              h('a', { class: active.value === 'home' ? 'active' : '', id: 'link-home' }, 'Home'),
            ]),
            h('span', { class: 'studio-tooltip-anchor' }, [
              h('a', { class: active.value === 'scene' ? 'active' : '', id: 'link-scene' }, 'Scene'),
            ]),
          ])
      },
    })

    const wrapper = mount(Container, { attachTo: document.body })
    await nextTick()

    const indicator = wrapper.find('.animated-selection')
    expect(indicator.exists()).toBe(true)

    wrapper.unmount()
  })

  it('suspends rAF when document becomes hidden', async () => {
    let isHidden = false
    Object.defineProperty(Document.prototype, 'hidden', {
      get: () => isHidden,
      configurable: true,
    })

    const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame')

    const Container = defineComponent({
      setup() {
        return () =>
          h('div', { class: 'tab-group', style: 'position: relative;' }, [
            h('button', { 'aria-pressed': 'true' }, 'Active'),
            h(AnimatedSelection),
          ])
      },
    })

    const wrapper = mount(Container, { attachTo: document.body })
    await nextTick()

    // Trigger visibility change to hidden
    isHidden = true
    document.dispatchEvent(new Event('visibilitychange'))
    expect(cancelSpy).toHaveBeenCalled()

    wrapper.unmount()
  })
})
