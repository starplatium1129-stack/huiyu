import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { SelectRoot } from 'reka-ui'
import StudioSelect from './StudioSelect.vue'

const flatOptions = [
  { value: 'opt1', label: '选项一' },
  { value: 'opt2', label: '选项二' },
]

function mountSelect(props: Record<string, unknown>) {
  return mount(StudioSelect, { props: { options: flatOptions, ...props }, attachTo: document.body })
}

/**
 * happy-dom 里 Reka 的弹层不参与真实指针流程（trigger 靠 pointerdown 打开，
 * 且内容走 Portal 挂载），所以值的回写映射直接用 SelectRoot 的 update:modelValue
 * 验证——这正是弹层点击后组件内部走的同一条路径。
 */
function chooseKey(wrapper: ReturnType<typeof mountSelect>, key: string) {
  const root = wrapper.findComponent(SelectRoot) as unknown as { vm: { $emit: (event: string, value: string) => void } }
  root.vm.$emit('update:modelValue', key)
}

describe('StudioSelect', () => {
  it('renders the trigger with the label as accessible name', () => {
    const wrapper = mountSelect({ modelValue: 'opt1', label: '测试下拉' })
    const trigger = wrapper.find('.studio-select-trigger')
    expect(trigger.exists()).toBe(true)
    expect(trigger.attributes('aria-label')).toBe('测试下拉')
  })

  // 仓库 e2e（apple-hig-accessibility / companion-focus）要求对话框与桌宠面板内
  // 原生控件数量为 0，所以组件自身不得再渲染兼容用的隐藏 <select>。
  it('never renders a native select element', async () => {
    const wrapper = mountSelect({ modelValue: 'opt1', label: '测试下拉' })
    expect(wrapper.find('select').exists()).toBe(false)
    expect(wrapper.find('.studio-select-native').exists()).toBe(false)
    await wrapper.find('.studio-select-trigger').trigger('click')
    await nextTick()
    expect(document.querySelector('select')).toBeNull()
  })

  it('puts the id on the visible trigger so label[for] names the control', () => {
    const wrapper = mountSelect({ modelValue: 'opt1', id: 'demo-select' })
    expect(wrapper.find('.studio-select-trigger').attributes('id')).toBe('demo-select')
    expect(wrapper.find('.studio-select-wrapper').attributes('id')).toBeUndefined()
  })

  it('shows the placeholder only when no option matches the value', async () => {
    const wrapper = mountSelect({ modelValue: '', placeholder: '请选择' })
    expect(wrapper.find('.studio-select-value').text()).toBe('请选择')
    expect(wrapper.find('.studio-select-trigger').attributes('data-empty')).toBeDefined()

    await wrapper.setProps({ modelValue: 'opt2' })
    expect(wrapper.find('.studio-select-value').text()).toBe('选项二')
    expect(wrapper.find('.studio-select-trigger').attributes('data-empty')).toBeUndefined()
  })

  // 「全部分类 / 自动 / 无参考」在原实现里是 value="" 的真实选项，不是未选择状态。
  it('treats an empty-string option as a real selectable value', () => {
    const wrapper = mountSelect({
      modelValue: '',
      options: [{ value: '', label: '全部分类' }, { value: 'a', label: '分类 A' }],
    })
    expect(wrapper.find('.studio-select-value').text()).toBe('全部分类')
    expect(wrapper.find('.studio-select-trigger').attributes('data-empty')).toBeUndefined()
  })

  it('round-trips number values without turning them into strings', async () => {
    const wrapper = mountSelect({
      modelValue: 1.5,
      options: [{ value: 1.5, label: '1.5×' }, { value: 2, label: '2×' }],
    })
    expect(wrapper.find('.studio-select-value').text()).toBe('1.5×')

    chooseKey(wrapper, '2')
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([2])
  })

  it('maps the empty-string option back to an empty string', async () => {
    const wrapper = mountSelect({
      modelValue: 'a',
      options: [{ value: '', label: '全部分类' }, { value: 'a', label: '分类 A' }],
    })
    chooseKey(wrapper, '__studio-select-empty__')
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([''])
  })

  // 原生 optgroup 的等价物：分组只影响弹层结构，取值与显示仍走同一套映射。
  it('flattens grouped options so the selected label still resolves', async () => {
    const wrapper = mountSelect({
      modelValue: '1024x1024',
      groups: [
        { label: '竖图 Portrait', options: [{ value: '768x1344', label: '768×1344' }] },
        { label: '方图 Square', options: [{ value: '1024x1024', label: '1024×1024', disabled: true }] },
      ],
    })
    expect(wrapper.find('.studio-select-value').text()).toBe('1024×1024')

    chooseKey(wrapper, '768x1344')
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['768x1344'])
  })

  it('keeps the wrapper as the layout box so page CSS can size the control', () => {
    const wrapper = mountSelect({ modelValue: 'opt1', class: 'model-select', inline: true })
    const root = wrapper.find('.studio-select-wrapper')
    expect(root.classes()).toContain('model-select')
    expect(root.classes()).toContain('studio-select-inline')
  })

  it('delegates hint to StudioTooltip instead of setting a native title attribute', () => {
    const wrapper = mountSelect({ modelValue: 'opt1', hint: '采样器说明' })
    const trigger = wrapper.find('.studio-select-trigger')
    expect(trigger.attributes('title')).toBeUndefined()
    const tooltip = wrapper.findComponent({ name: 'StudioTooltip' })
    expect(tooltip.exists()).toBe(true)
    expect(tooltip.props('content')).toBe('采样器说明')
    expect(tooltip.props('anchor')).toBe(false)
  })

  it('enables tooltip anchor when the select is disabled so hover still triggers hint', () => {
    const wrapper = mountSelect({ modelValue: 'opt1', hint: '生成中不可切换', disabled: true })
    const trigger = wrapper.find('.studio-select-trigger')
    expect(trigger.attributes('title')).toBeUndefined()
    const tooltip = wrapper.findComponent({ name: 'StudioTooltip' })
    expect(tooltip.exists()).toBe(true)
    expect(tooltip.props('content')).toBe('生成中不可切换')
    expect(tooltip.props('anchor')).toBe(true)
  })
})
