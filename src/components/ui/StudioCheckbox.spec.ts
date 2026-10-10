import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { expect, it } from 'vitest'
import StudioCheckbox from './StudioCheckbox.vue'

it('exposes real mixed/checked state and emits one native change from its label', async () => {
  const wrapper = mount(StudioCheckbox, {
    attachTo: document.body,
    props: { checked: false, indeterminate: true, label: '全选当前作品' },
    slots: { default: '全选当前' },
  })
  try {
    const input = wrapper.get('input').element as HTMLInputElement
    expect(input.type).toBe('checkbox')
    expect(input.indeterminate).toBe(true)
    expect(input.checked).toBe(false)
    expect(input.getAttribute('aria-label')).toBe('全选当前作品')
    ;(wrapper.element as HTMLLabelElement).click()
    expect(wrapper.emitted('update:checked')).toEqual([[true]])
    await wrapper.setProps({ checked: true, indeterminate: false })
    expect(input.checked).toBe(true)
    expect(input.indeterminate).toBe(false)
    await wrapper.setProps({ checked: false })
    expect(input.checked).toBe(false)
    wrapper.vm.focus()
    expect(document.activeElement).toBe(input)
    await wrapper.setProps({ disabled: true })
    input.click()
    await nextTick()
    expect(input.disabled).toBe(true)
    expect(wrapper.emitted('update:checked')).toHaveLength(1)
  } finally { wrapper.unmount() }
})
