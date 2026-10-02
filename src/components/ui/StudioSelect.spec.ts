import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { SelectRoot } from 'reka-ui'
import StudioSelect from './StudioSelect.vue'

const mounted: Array<{ unmount(): void }> = []
afterEach(async () => {
  mounted.splice(0).forEach(wrapper => wrapper.unmount())
  await flushPromises()
  document.body.innerHTML = ''
})

const flatOptions = [
  { value: 'opt1', label: '选项一' },
  { value: 'opt2', label: '选项二' },
]

function mountSelect(props: Record<string, unknown>) {
  const wrapper = mount(StudioSelect, { props: { options: flatOptions, ...props }, attachTo: document.body })
  mounted.push(wrapper)
  return wrapper
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
  it('shows the placeholder only when no option matches the value', async () => {
    const wrapper = mountSelect({ modelValue: '', placeholder: '请选择', label: '测试下拉', id: 'demo-select' })
    expect(wrapper.get('.studio-select-trigger').attributes('aria-label')).toBe('测试下拉')
    expect(wrapper.get('.studio-select-trigger').attributes('id')).toBe('demo-select')
    expect(wrapper.get('.studio-select-wrapper').attributes('id')).toBeUndefined()
    expect(wrapper.find('.studio-select-value').text()).toBe('请选择')
    expect(wrapper.find('.studio-select-trigger').attributes('data-empty')).toBeDefined()

    await wrapper.setProps({ modelValue: 'opt2' })
    expect(wrapper.find('.studio-select-value').text()).toBe('选项二')
    expect(wrapper.find('.studio-select-trigger').attributes('data-empty')).toBeUndefined()
  })

  // 「全部分类 / 自动 / 无参考」在原实现里是 value="" 的真实选项，不是未选择状态。
  it('treats an empty-string option as a real value and emits its original type', async () => {
    const wrapper = mountSelect({
      modelValue: '',
      options: [{ value: '', label: '全部分类' }, { value: 'a', label: '分类 A' }],
    })
    expect(wrapper.find('.studio-select-value').text()).toBe('全部分类')
    expect(wrapper.find('.studio-select-trigger').attributes('data-empty')).toBeUndefined()
    await wrapper.setProps({ modelValue: 'a' })
    chooseKey(wrapper, '__studio-select-empty__')
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([''])
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

  it('shows its hint when the visible select receives keyboard focus', async () => {
    const wrapper = mountSelect({ modelValue: 'opt1', hint: '采样器说明' })
    const trigger = wrapper.find('.studio-select-trigger')
    expect(trigger.attributes('title')).toBeUndefined()
    await trigger.trigger('focus')
    await flushPromises()
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('采样器说明')
  })

  it('keeps a disabled select hint reachable through keyboard focus', async () => {
    const wrapper = mountSelect({ modelValue: 'opt1', hint: '生成中不可切换', disabled: true })
    const trigger = wrapper.find('.studio-select-trigger')
    expect(trigger.attributes('title')).toBeUndefined()
    await flushPromises()
    const anchor = wrapper.get('.studio-tooltip-anchor')
    expect(anchor.attributes('tabindex')).toBe('0')
    await anchor.trigger('focus')
    await flushPromises()
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('生成中不可切换')
  })
})
