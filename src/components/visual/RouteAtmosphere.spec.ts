import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import RouteAtmosphere from './RouteAtmosphere.vue'

describe('RouteAtmosphere decoration layer (009 F5.4)', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-fluid-effects')
    document.documentElement.removeAttribute('data-reduced-glass')
  })

  afterEach(() => {
    document.documentElement.removeAttribute('data-fluid-effects')
    document.documentElement.removeAttribute('data-reduced-glass')
  })

  it('renders decorative aura layers with strict containment and hidden accessibility', () => {
    const wrapper = mount(RouteAtmosphere)
    const el = wrapper.find('.route-atmosphere')
    expect(el.exists()).toBe(true)
    expect(el.attributes('aria-hidden')).toBe('true')
    expect(el.findAll('i').length).toBe(2)
  })
})
