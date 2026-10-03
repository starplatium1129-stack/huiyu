import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import DirectorResultTools from './DirectorResultTools.vue'
import DirectorImageTools from './DirectorImageTools.vue'
import GenerationActionBar from './GenerationActionBar.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'

const props = {
  generationBusy: false, interrogateBusy: false, interrogateMode: 'tag' as const,
  displayResultUrl: '/result.png', drawEngine: 'anima', inpaintOriginalUrl: null,
  inpaintCompareActive: false, shotsPending: 2, hasPrevResult: true,
  resultArchived: false, resultTemporary: true,
  interrogateError: null,
}
describe('result tools', () => {
  it('keeps canvas saving, sidebar actions and clearing independently callable', async () => {
    const wrapper = mount(DirectorResultTools, { props })
    const buttons = wrapper.findAll('button')
    const save = buttons.find(button => button.text() === '存入作品册')!
    const compare = buttons.find(button => button.text() === '与上一张对比')!
    const scene = buttons.find(button => button.text().includes('保存为场景'))!
    await scene.trigger('click')
    expect(wrapper.emitted('saveScene')).toHaveLength(1)
    await save.trigger('click')
    await compare.trigger('click')
    expect(wrapper.emitted('saveResult')).toHaveLength(1)
    expect(wrapper.emitted('openCompare')).toHaveLength(1)
    expect(wrapper.text()).toContain('未入册 · 已暂存')
    await wrapper.get('button[aria-label="作品环境光"]').trigger('click')
    expect(wrapper.emitted('update:ambientEnabled')).toEqual([[false]])
    await wrapper.setProps({ generationBusy:true })
    expect(wrapper.get('.stage-result-status').text()).toContain('当前成片保留')
    const tools = mount(DirectorImageTools, { props })
    await tools.findAll('button').find(button => button.text() === '加入分镜')!.trigger('click')
    expect(tools.emitted('addToShots')).toHaveLength(1)
    const bar = mount(GenerationActionBar, { props: {
      engine: 'anima', busy: false, online: true, size: '896x1344',
      animaSizes: ['896x1344'], presetSummary: '', hasResult: true,
    } })
    const clear = bar.findAll('button').find(button => button.text() === '清除图片')!
    const action = bar.get('[data-testid="anima-generate"]').element
    await clear.trigger('click')
    expect(bar.emitted('clearResult')).toHaveLength(1)
    await bar.setProps({ hasResult: false })
    expect(clear.attributes('disabled')).toBeDefined()
    await clear.trigger('click')
    expect(bar.emitted('clearResult')).toHaveLength(1)
    await bar.setProps({ busy: true, online: false })
    const stop = bar.get('[data-testid="anima-generate"]')
    expect(stop.element).toBe(action)
    expect(stop.text()).toBe('停止绘制')
    expect(stop.attributes('disabled')).toBeUndefined()
    await stop.trigger('click')
    expect(bar.emitted('cancel')).toHaveLength(1)
    expect(bar.emitted('generate')).toBeUndefined()
    await bar.setProps({ progress: .45 })
    expect(bar.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('45')
    expect(stop.text()).toContain('45%')
    await bar.setProps({ progress: null })
    expect(bar.get('[role="progressbar"]').attributes('aria-valuenow')).toBeUndefined()
    await bar.setProps({ busy: false, online: true })
    await stop.trigger('click')
    expect(bar.emitted('generate')).toHaveLength(1)
    bar.unmount(); tools.unmount(); wrapper.unmount()
  })
  it('continues focused saving on the archive link without stealing a new focus target', async () => {
    const wrapper = mount(DirectorResultTools, { props, attachTo:document.body, global:{ stubs:{ RouterLink:{ props:['to'], template:'<a :href="to"><slot /></a>' } } } })
    const save = wrapper.get<HTMLButtonElement>('.result-archive-action')
    save.element.focus()
    await save.trigger('click')
    await wrapper.setProps({ savingResult:true })
    save.element.blur()
    expect(wrapper.get('[role="status"]').text()).toContain('正在入册')
    await wrapper.setProps({ savingResult:false, resultArchived:true })
    await nextTick()
    expect(document.activeElement).toBe(wrapper.get('.result-archive-action').element)
    await wrapper.setProps({ resultArchived:false })
    wrapper.get<HTMLButtonElement>('.result-archive-action').element.focus()
    await wrapper.get('.result-archive-action').trigger('click')
    const other = document.createElement('button'); document.body.append(other); other.focus()
    await wrapper.setProps({ resultArchived:true })
    await nextTick()
    expect(document.activeElement).toBe(other)
    other.remove(); wrapper.unmount()
  })
  it('retains busy-state explanations and disables changes during generation', () => {
    const wrapper = mount(DirectorImageTools, { props: { ...props, generationBusy: true } })
    const tooltips = wrapper.findAllComponents(StudioTooltip)
    for (const label of ['局部换装', '高清放大 2x', '生成短片', '加入分镜']) {
      const button = wrapper.findAll('button').find(item => item.text() === label)!
      expect(button.attributes('disabled')).toBeDefined()
      // 提示已从原生 title 换成 StudioTooltip：断言「禁用原因」跟着这个按钮走。
      // 原生 title 在禁用控件上多数浏览器根本不弹，所以这条断言比原来更有意义。
      const anchor = button.element.closest('.studio-tooltip-anchor')
      const tooltip = tooltips.find(item => item.element === anchor)
      expect(tooltip, `${label} 缺少包裹它的提示`).toBeTruthy()
      expect(String(tooltip!.props('content'))).toContain('生成中')
      // 禁用控件不派发指针事件，提示必须靠外壳接住 hover
      expect(tooltip!.props('anchor')).toBe(true)
    }
    wrapper.unmount()
  })
})
