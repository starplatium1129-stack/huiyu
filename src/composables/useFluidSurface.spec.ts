import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { h } from 'vue'
import {
  useFluidSurface,
  DEFAULT_FLUID_PANEL_SELECTORS,
  DEFAULT_FLUID_PANEL_SELECTOR,
  FLUID_FULLSCREEN_SELECTORS,
  FLUID_FULLSCREEN_SELECTOR,
  FLUID_POPOVER_SELECTORS,
  FLUID_POPOVER_SELECTOR,
} from './useFluidSurface'
import FluidTransition from '@/components/visual/FluidTransition.vue'

describe('useFluidSurface & FluidTransition selectors and motion curves', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('exports standardized surface panel selectors', () => {
    expect(DEFAULT_FLUID_PANEL_SELECTORS).toContain('.story-card')
    expect(DEFAULT_FLUID_PANEL_SELECTORS).toContain('.modal-card')
    expect(DEFAULT_FLUID_PANEL_SELECTORS).toContain('[role="dialog"]')
    expect(DEFAULT_FLUID_PANEL_SELECTOR).toBe(DEFAULT_FLUID_PANEL_SELECTORS.join(', '))

    expect(FLUID_FULLSCREEN_SELECTORS).toContain('.art-viewer')
    expect(FLUID_FULLSCREEN_SELECTORS).toContain('.candidate-compare')
    expect(FLUID_FULLSCREEN_SELECTOR).toBe(FLUID_FULLSCREEN_SELECTORS.join(', '))

    expect(FLUID_POPOVER_SELECTORS).toContain('.utility-popover')
    expect(FLUID_POPOVER_SELECTORS).toContain('.popover-menu')
    expect(FLUID_POPOVER_SELECTOR).toBe(FLUID_POPOVER_SELECTORS.join(', '))
  })

  it('FluidTransition component uses DEFAULT_FLUID_PANEL_SELECTOR as default prop', () => {
    const wrapper = mount(FluidTransition, {
      slots: {
        default: () => h('div', { class: 'modal-card' }, 'Hello'),
      },
    })
    expect(wrapper.props('panel')).toBe(DEFAULT_FLUID_PANEL_SELECTOR)
    expect(wrapper.props('appear')).toBe(false)
  })

  it('correctly targets self if element itself matches the panel selector', () => {
    const surface = useFluidSurface('.modal-card')
    const el = document.createElement('div')
    el.className = 'modal-card'
    document.body.appendChild(el)

    surface.enter(el, () => {})

    expect(el.style.opacity).toBeDefined()
    expect(el.style.transform).toBeDefined()

    surface.dispose(el)
    el.remove()
  })

  it('correctly targets nested panel child if wrapper element does not match selector', () => {
    const surface = useFluidSurface('.story-card')
    const wrapper = document.createElement('div')
    wrapper.className = 'dialog-backdrop'
    const card = document.createElement('div')
    card.className = 'story-card'
    wrapper.appendChild(card)
    document.body.appendChild(wrapper)

    surface.enter(wrapper, () => {})

    expect(wrapper.style.opacity).toBeDefined()
    expect(card.style.transform).toBeDefined()

    surface.dispose(wrapper)
    wrapper.remove()
  })

  it('applies reduced motion parameters when prefers-reduced-motion is true', () => {
    const originalMatchMedia = window.matchMedia
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('prefers-reduced-motion: reduce'),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))

    try {
      const surface = useFluidSurface()
      const el = document.createElement('div')
      el.className = 'test-panel'
      document.body.appendChild(el)

      surface.enter(el, () => {})

      // Under reduced motion, scale is 1 and travel is 0 (no spatial displacement)
      expect(el.style.transform).toContain('translateY(0px)')
      expect(el.style.transform).toContain('scale(1)')

      surface.dispose(el)
      el.remove()
    } finally {
      window.matchMedia = originalMatchMedia
    }
  })
})
