import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import BorderBeam from './BorderBeam.vue'

describe('BorderBeam visual component', () => {
  it('renders default slot content with active beam tracks', () => {
    const wrapper = mount(BorderBeam, {
      slots: {
        default: '<button class="test-btn">测试按钮</button>',
      },
    })

    expect(wrapper.find('.test-btn').exists()).toBe(true)
    expect(wrapper.find('.border-beam-track').exists()).toBe(true)
    expect(wrapper.find('.border-beam-bloom').exists()).toBe(true)

    const track = wrapper.find('.border-beam-track')
    expect(track.attributes('aria-hidden')).toBe('true')
  })

  it('hides beam tracks when active is false', () => {
    const wrapper = mount(BorderBeam, {
      props: {
        active: false,
      },
      slots: {
        default: '<div class="card-content">卡片内容</div>',
      },
    })

    expect(wrapper.find('.card-content').exists()).toBe(true)
    expect(wrapper.find('.border-beam-track').exists()).toBe(false)
    expect(wrapper.find('.border-beam-bloom').exists()).toBe(false)
  })

  it('applies is-standalone class when no slot is passed', () => {
    const wrapper = mount(BorderBeam)
    expect(wrapper.classes()).toContain('is-standalone')
  })

  it('supports hiding bloom glow with prop', () => {
    const wrapper = mount(BorderBeam, {
      props: {
        glow: false,
      },
    })

    expect(wrapper.find('.border-beam-track').exists()).toBe(true)
    expect(wrapper.find('.border-beam-bloom').exists()).toBe(false)
  })

  it('applies colorVariant classes properly', () => {
    const wrapper = mount(BorderBeam, {
      props: {
        colorVariant: 'violet',
      },
    })

    expect(wrapper.classes()).toContain('variant-violet')
  })
})
