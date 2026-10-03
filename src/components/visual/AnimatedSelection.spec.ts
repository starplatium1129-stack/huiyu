import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import AnimatedSelection from './AnimatedSelection.vue'
import { frameData, frameSteps } from 'motion'

describe('AnimatedSelection lifecycle and background suspension', () => {
  let originalHidden: PropertyDescriptor | undefined

  beforeEach(() => {
    document.body.innerHTML = ''
    originalHidden = Object.getOwnPropertyDescriptor(document, 'hidden')
  })

  afterEach(() => {
    if (originalHidden) {
      Object.defineProperty(document, 'hidden', originalHidden)
    } else Reflect.deleteProperty(document, 'hidden')
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('moves its painted indicator with pressed buttons and nested active links', async () => {
    const priorMotion = document.documentElement.dataset.motion
    document.documentElement.dataset.motion = 'reduce'
    try {
      for (const nested of [false, true]) {
        const selected = ref('a')
        const Container = defineComponent({ setup: () => () => h('div', [
          ...['a', 'b'].map(id => {
            const target = h(nested ? 'a' : 'button', {
              id,
              class: selected.value === id ? 'active' : '',
              'aria-pressed': selected.value === id ? 'true' : 'false',
            }, id)
            return nested ? h('span', [target]) : target
          }),
          h(AnimatedSelection, nested ? { target: ':scope > a.active' } : {}),
        ]) })
        const wrapper = mount(Container, { attachTo: document.body })
        try {
          vi.spyOn(wrapper.element, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 40))
          vi.spyOn(wrapper.get('#a').element, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 5, 80, 30))
          vi.spyOn(wrapper.get('#b').element, 'getBoundingClientRect').mockReturnValue(new DOMRect(110, 5, 100, 30))
          await flushPromises()
          frameSteps.read.process(frameData)
          frameSteps.render.process(frameData)
          const indicator = wrapper.get('.animated-selection').element as HTMLElement
          expect(indicator.style.opacity).toBe('1')
          expect(indicator.style.width).toBe('80px')
          expect(indicator.style.transform).toContain('translate(10px,5px)')
          selected.value = 'b'
          await flushPromises()
          frameSteps.read.process(frameData)
          frameSteps.render.process(frameData)
          expect(indicator.style.width).toBe('100px')
          expect(indicator.style.transform).toContain('translate(110px,5px)')
        } finally { wrapper.unmount() }
      }
    } finally {
      if (priorMotion === undefined) delete document.documentElement.dataset.motion
      else document.documentElement.dataset.motion = priorMotion
    }
  })

  it('places keyboard selections immediately even when full motion is enabled', async () => {
    const previous = document.documentElement.dataset.motion
    document.documentElement.dataset.motion = 'full'
    const selected = ref('a')
    const Container = defineComponent({ setup:() => () => h('div', [
      ...['a','b'].map(id => h('button',{id,'aria-pressed':selected.value === id ? 'true':'false'},id)), h(AnimatedSelection),
    ]) })
    const wrapper = mount(Container,{attachTo:document.body})
    try {
      vi.spyOn(wrapper.element,'getBoundingClientRect').mockReturnValue(new DOMRect(0,0,300,40))
      vi.spyOn(wrapper.get('#a').element,'getBoundingClientRect').mockReturnValue(new DOMRect(10,5,80,30))
      vi.spyOn(wrapper.get('#b').element,'getBoundingClientRect').mockReturnValue(new DOMRect(110,5,100,30))
      await flushPromises(); frameSteps.read.process(frameData); frameSteps.render.process(frameData)
      await wrapper.get('#b').trigger('keydown',{key:'ArrowRight'}); selected.value = 'b'
      await flushPromises(); frameSteps.read.process(frameData); frameSteps.render.process(frameData)
      expect((wrapper.get('.animated-selection').element as HTMLElement).style.transform).toContain('translate(110px,5px)')
    } finally {
      wrapper.unmount()
      if (previous === undefined) delete document.documentElement.dataset.motion
      else document.documentElement.dataset.motion = previous
    }
  })
  it('supports arrow and boundary keys on plain segmented radio groups', async () => {
    const selected = ref('a')
    const Container = defineComponent({ setup: () => () => h('div', { class: 'studio-segments', role: 'radiogroup' }, [
      ...['a', 'b', 'c'].map(id => h('button', {
        id, role: 'radio', disabled: id === 'b', 'aria-checked': selected.value === id ? 'true' : 'false',
        onClick: () => { selected.value = id },
      }, id)), h(AnimatedSelection),
    ]) })
    const wrapper = mount(Container, { attachTo: document.body })
    try {
      for (const button of wrapper.findAll('button')) vi.spyOn(button.element, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 80, 40))
      await wrapper.get('#a').trigger('keydown', { key: 'ArrowRight' })
      expect(wrapper.get('#c').attributes('aria-checked')).toBe('true')
      expect(document.activeElement).toBe(wrapper.get('#c').element)
      await wrapper.get('#c').trigger('keydown', { key: 'Home' })
      expect(wrapper.get('#a').attributes('aria-checked')).toBe('true')
      await wrapper.get('#a').trigger('keydown', { key: 'End' })
      expect(wrapper.get('#c').attributes('aria-checked')).toBe('true')
    } finally { wrapper.unmount() }
  })
  it('suspends rAF when document becomes hidden', async () => {
    let isHidden = false
    Object.defineProperty(document, 'hidden', {
      get: () => isHidden,
      configurable: true,
    })

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

    const readSpy = vi.spyOn(wrapper.get('button').element, 'getBoundingClientRect')
    // Trigger visibility change to hidden
    isHidden = true
    expect(document.hidden).toBe(true)
    document.dispatchEvent(new Event('visibilitychange'))
    readSpy.mockClear()
    frameSteps.read.process(frameData)
    expect(readSpy).not.toHaveBeenCalled()
    isHidden = false
    document.dispatchEvent(new Event('visibilitychange'))
    frameSteps.read.process(frameData)
    expect(readSpy).toHaveBeenCalled()

    wrapper.unmount()
  })
})
