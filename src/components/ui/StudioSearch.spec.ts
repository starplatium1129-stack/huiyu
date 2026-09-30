import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import StudioSearch from './StudioSearch.vue'
describe('collection search keyboard', () => {
  it('preserves IME composition, clears on Escape, and refocuses the field after button clearing', async () => {
    const wrapper=mount(StudioSearch,{attachTo:document.body,props:{modelValue:'樱花',label:'搜索作品'}})
    await wrapper.get('input').trigger('keydown',{key:'Escape',isComposing:true})
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    await wrapper.get('input').trigger('keydown',{key:'Escape'})
    expect(wrapper.emitted('update:modelValue')).toEqual([['']])
    await wrapper.setProps({modelValue:'新关键词'})
    await wrapper.get('button').trigger('click')
    expect(wrapper.emitted('update:modelValue')).toEqual([[''],['']])
    expect(document.activeElement).toBe(wrapper.get('input').element); wrapper.unmount()
  })
})
