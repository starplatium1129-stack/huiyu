import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import StudioSearch from './StudioSearch.vue'
describe('collection search keyboard', () => {
  it('keeps IME composition intact and clears on a later Escape', async () => {
    const wrapper=mount(StudioSearch,{props:{modelValue:'樱花',label:'搜索作品'}})
    await wrapper.get('input').trigger('keydown',{key:'Escape',isComposing:true})
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    await wrapper.get('input').trigger('keydown',{key:'Escape'})
    expect(wrapper.emitted('update:modelValue')).toEqual([['']]); wrapper.unmount()
  })
  it('returns keyboard focus to the search field after clearing', async () => {
    const wrapper=mount(StudioSearch,{attachTo:document.body,props:{modelValue:'樱花',label:'搜索作品'}})
    await wrapper.get('button').trigger('click')
    expect(document.activeElement).toBe(wrapper.get('input').element); wrapper.unmount()
  })
})
