import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import RouteAtmosphere from './RouteAtmosphere.vue'

describe('RouteAtmosphere decoration layer', () => {
  it('renders one contained decoration surface without intercepting input or accessibility', () => {
    const wrapper = mount(RouteAtmosphere)
    const el = wrapper.get('.route-atmosphere')
    expect(el.attributes('aria-hidden')).toBe('true')
    expect(el.classes()).toEqual(expect.arrayContaining(['tw:pointer-events-none', 'tw:[contain:strict]']))
    expect(el.element.children).toHaveLength(0)
    expect(el.attributes('tabindex')).toBeUndefined()
    wrapper.unmount()
  })
})
