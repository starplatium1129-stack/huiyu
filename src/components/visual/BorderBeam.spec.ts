import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import BorderBeam from './BorderBeam.vue'

describe('BorderBeam visual component', () => {
  it('preserves slot content while independently disabling decoration and bloom', async () => {
    const wrapper = mount(BorderBeam, {
      slots: {
        default: '<button class="test-btn">测试按钮</button>',
      },
    })

    expect(wrapper.find('.border-beam-bloom').exists()).toBe(true)
    const content = wrapper.get('.test-btn').element
    const track = wrapper.get('.border-beam-track')
    expect(track.attributes('aria-hidden')).toBe('true')
    await wrapper.setProps({ active: false })
    expect(wrapper.get('.test-btn').element).toBe(content)
    expect(wrapper.find('.border-beam-track').exists()).toBe(false)
    expect(wrapper.find('.border-beam-bloom').exists()).toBe(false)
    await wrapper.setProps({ active: true, glow: false })
    expect(wrapper.find('.border-beam-track').exists()).toBe(true)
    expect(wrapper.find('.border-beam-bloom').exists()).toBe(false)
    expect(wrapper.get('.test-btn').element).toBe(content)
    wrapper.unmount()
  })
})
