import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import ThinkingOrb from './ThinkingOrb.vue'

describe('ThinkingOrb component', () => {
  it('announces its current state and allows an accessible label override', async () => {
    const wrapper = mount(ThinkingOrb, {
      props: {
        state: 'working',
        size: 'md',
      },
    })

    const host = wrapper.get('[role="status"]')
    expect(host.attributes('role')).toBe('status')
    expect(host.attributes('aria-label')).toBe('心动画面显影生成中…')

    expect(wrapper.get('canvas').attributes('aria-hidden')).toBe('true')
    await wrapper.setProps({ state: 'weaving' })
    expect(wrapper.attributes('aria-label')).toBe('正在编织画面意境…')
    await wrapper.setProps({ ariaLabel: '自定义加载文案' })
    expect(wrapper.attributes('aria-label')).toBe('自定义加载文案')
    wrapper.unmount()
  })
})
