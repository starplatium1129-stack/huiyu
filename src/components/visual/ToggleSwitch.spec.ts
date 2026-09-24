import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import ToggleSwitch from './ToggleSwitch.vue'

describe('ToggleSwitch Reka adapter', () => {
  it('emits the boolean model and existing change callback once per activation', async () => {
    const wrapper = mount(ToggleSwitch, { props: { modelValue: false, label: '启用语音输入' } })
    const control = wrapper.get('[role="switch"]')
    expect(control.attributes('type')).toBe('button')
    expect(control.attributes('aria-label')).toBe('启用语音输入')
    expect(control.classes()).toContain('toggle-switch-icon-only')
    await control.trigger('click')
    expect(wrapper.emitted('update:modelValue')).toEqual([[true]])
    expect(wrapper.emitted('change')).toEqual([[true]])
    await wrapper.setProps({ modelValue: true })
    expect(control.attributes('aria-checked')).toBe('true')
    await control.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('change')).toEqual([[true], [false]])
    wrapper.unmount()
  })

  it('ignores disabled activation and does not emit changes for external updates', async () => {
    const wrapper = mount(ToggleSwitch, { props: { modelValue: false, disabled: true }, slots: { default: '管理已隐藏' } })
    const control = wrapper.get('[role="switch"]')
    expect(control.text()).toBe('管理已隐藏')
    expect(control.classes()).not.toContain('toggle-switch-icon-only')
    await control.trigger('click')
    await control.trigger('keydown', { key: 'Enter' })
    await wrapper.setProps({ modelValue: true })
    expect(control.attributes('aria-checked')).toBe('true')
    expect(wrapper.emitted('change')).toBeUndefined()
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    wrapper.unmount()
  })
})
