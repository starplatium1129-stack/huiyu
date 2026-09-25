import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import ThinkingOrb from './ThinkingOrb.vue'

describe('ThinkingOrb component', () => {
  it('renders status container with canvas and aria accessibility', () => {
    const wrapper = mount(ThinkingOrb, {
      props: {
        state: 'working',
        size: 'md',
      },
    })

    const host = wrapper.find('.thinking-orb-host')
    expect(host.exists()).toBe(true)
    expect(host.attributes('role')).toBe('status')
    expect(host.attributes('aria-label')).toBe('心动画面显影生成中…')

    const canvas = wrapper.find('canvas.thinking-orb-canvas')
    expect(canvas.exists()).toBe(true)
  })

  it('updates aria-label according to state or prop override', () => {
    const wrapper = mount(ThinkingOrb, {
      props: {
        state: 'weaving',
      },
    })

    expect(wrapper.attributes('aria-label')).toBe('正在编织画面意境…')

    const wrapperCustom = mount(ThinkingOrb, {
      props: {
        state: 'working',
        ariaLabel: '自定义加载文案',
      },
    })
    expect(wrapperCustom.attributes('aria-label')).toBe('自定义加载文案')
  })

  it('applies preset size classes', () => {
    const wrapperSm = mount(ThinkingOrb, { props: { size: 'sm' } })
    expect(wrapperSm.classes()).toContain('size-sm')

    const wrapperLg = mount(ThinkingOrb, { props: { size: 'lg' } })
    expect(wrapperLg.classes()).toContain('size-lg')
  })

  it('handles paused prop cleanly', () => {
    const wrapper = mount(ThinkingOrb, {
      props: {
        paused: true,
      },
    })

    expect(wrapper.classes()).toContain('is-paused')
  })
})
