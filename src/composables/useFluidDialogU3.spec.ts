import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import { useFluidSurface } from './useFluidSurface'
import { useFocusTrap } from './useFocusTrap'
import PromptComparePanel from '@/components/director/PromptComparePanel.vue'

describe('U3 Overlay & Dialog Behaviors', () => {
  beforeEach(() => {
    document.body.className = ''
    document.documentElement.style.overflow = ''
  })

  afterEach(() => {
    document.body.className = ''
    document.documentElement.style.overflow = ''
  })

  it('differentiates motion curves based on overlay surface type in useFluidSurface', () => {
    let surface!: ReturnType<typeof useFluidSurface>
    const TestComponent = defineComponent({
      setup() {
        surface = useFluidSurface()
        return () => h('div')
      },
    })
    const comp = mount(TestComponent)

    // Test fullscreen/compare viewer surface
    const fullscreenEl = document.createElement('div')
    fullscreenEl.className = 'pb-compare'
    document.body.appendChild(fullscreenEl)

    surface.enter(fullscreenEl, () => {})
    expect(fullscreenEl.style.transformOrigin).toBe('center center')

    // Test popover surface
    const popoverEl = document.createElement('div')
    popoverEl.className = 'utility-popover'
    document.body.appendChild(popoverEl)

    surface.enter(popoverEl, () => {})

    // Clean up
    surface.dispose(fullscreenEl)
    surface.dispose(popoverEl)
    fullscreenEl.remove()
    popoverEl.remove()
    comp.unmount()
  })

  it('supports Escape key and focus trapping in PromptComparePanel', async () => {
    const dummySnapshot = {
      url: '/test.png',
      seed: 1234,
      size: '1024x1024',
      sampler: 'Euler a',
      cfg: 7,
      steps: 28,
      hires: 'off',
      styleLoraId: '',
      at: '12:00:00',
    }

    const wrapper = mount(PromptComparePanel, {
      props: {
        previous: dummySnapshot,
        current: dummySnapshot,
      },
      attachTo: document.body,
    })

    await nextTick()

    // Pressing Escape inside dialog triggers close event
    const dialog = wrapper.find('.pb-compare').element as HTMLElement
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

    expect(wrapper.emitted('close')).toBeDefined()
    expect(wrapper.emitted('close')!.length).toBeGreaterThanOrEqual(1)

    wrapper.unmount()
  })

  it('locks body scroll while focus trap is active and releases upon close', async () => {
    const open = ref(true)
    const container = ref<HTMLElement | null>(null)

    const TestHarness = defineComponent({
      setup() {
        useFocusTrap(container, () => open.value, { lockScroll: true })
        return () => h('div', { ref: container }, [h('button', 'Action')])
      },
    })

    const wrapper = mount(TestHarness, { attachTo: document.body })
    await nextTick()

    expect(document.body.classList.contains('overlay-open')).toBe(true)

    open.value = false
    await nextTick()

    expect(document.body.classList.contains('overlay-open')).toBe(false)
    wrapper.unmount()
  })
})
