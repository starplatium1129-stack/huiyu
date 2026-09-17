import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import DirectorResultTools from './DirectorResultTools.vue'

const props = {
  generationBusy: false, interrogateBusy: false, interrogateMode: 'tag' as const,
  displayResultUrl: '/result.png', drawEngine: 'anima', inpaintOriginalUrl: null,
  inpaintCompareActive: false, shotsPending: 2, hasPrevResult: true,
  resultArchived: false, resultTemporary: true,
}
describe('result tools', () => {
  it('keeps save and comparison outside the collapsed secondary tools', async () => {
    const wrapper = mount(DirectorResultTools, { props })
    expect(wrapper.get('details').attributes('open')).toBeUndefined()
    const buttons = wrapper.findAll('button')
    const save = buttons.find(button => button.text() === '存入作品册')!
    const compare = buttons.find(button => button.text() === '与上一张对比')!
    expect(save.element.closest('details')).toBeNull()
    expect(compare.element.closest('details')).toBeNull()
    await save.trigger('click')
    await compare.trigger('click')
    expect(wrapper.emitted('saveResult')).toHaveLength(1)
    expect(wrapper.emitted('openCompare')).toHaveLength(1)
    await buttons.find(button => button.text() === '加入分镜')!.trigger('click')
    expect(wrapper.emitted('addToShots')).toHaveLength(1)
    expect(wrapper.text()).toContain('未入册 · 已暂存')
  })
  it('retains busy-state explanations and disables changes during generation', () => {
    const wrapper = mount(DirectorResultTools, { props: { ...props, generationBusy: true } })
    for (const label of ['局部换装', '高清放大 2x', '生成短片', '加入分镜']) {
      const button = wrapper.findAll('button').find(item => item.text() === label)!
      expect(button.attributes('disabled')).toBeDefined()
      expect(button.attributes('title')).toContain('生成中')
    }
  })
})
