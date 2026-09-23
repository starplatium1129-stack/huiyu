import { describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import StudioTooltip from './StudioTooltip.vue'

function mountTooltip(props: Record<string, unknown> = {}) {
  return mount(StudioTooltip, {
    props: { content: '采样步数：越多细节越足', ...props },
    slots: { default: '<button type="button">步数</button>' },
    attachTo: document.body,
  })
}

describe('StudioTooltip', () => {
  it('默认模式不产生额外盒子，DOM 与布局对调用方透明', () => {
    const wrapper = mountTooltip()
    const anchor = wrapper.find('.studio-tooltip-anchor')
    expect(anchor.exists()).toBe(true)
    // display:contents 由样式提供；这里契约是「没有 data-anchor」→ 不生成盒子
    expect(anchor.attributes('data-anchor')).toBeUndefined()
    expect(wrapper.find('button').text()).toBe('步数')
    wrapper.unmount()
  })

  it('控件可能被禁用时用 anchor 生成可接收 hover 的外壳', () => {
    const wrapper = mountTooltip({ anchor: true })
    const anchor = wrapper.find('.studio-tooltip-anchor')
    expect(anchor.attributes('data-anchor')).toBeDefined()
    expect(anchor.find('button').exists()).toBe(true)
    wrapper.unmount()
  })

  it('内容为空时退化为只渲染子元素，不挂任何提示语义', () => {
    const wrapper = mountTooltip({ content: '' })
    const button = wrapper.find('button')
    expect(button.attributes('aria-describedby')).toBeUndefined()
    expect(document.querySelector('.studio-tooltip')).toBeNull()
    wrapper.unmount()
  })

  it('键盘聚焦即显示提示，不依赖 hover 延迟', async () => {
    const wrapper = mountTooltip()
    await wrapper.find('button').trigger('focus')
    await flushPromises()

    const tip = document.querySelector('.studio-tooltip')
    expect(tip).not.toBeNull()
    expect(tip!.textContent).toContain('采样步数：越多细节越足')
    wrapper.unmount()
  })

  it('祖先有 dialog 时提示渲染进 dialog，否则会被弹窗盖住', async () => {
    const dialog = document.createElement('dialog')
    document.body.appendChild(dialog)
    const wrapper = mount(StudioTooltip, {
      props: { content: '弹窗内的提示' },
      slots: { default: '<button type="button">触发</button>' },
      attachTo: dialog,
    })
    await wrapper.find('button').trigger('focus')
    await flushPromises()

    const tip = document.querySelector('.studio-tooltip')
    expect(tip).not.toBeNull()
    expect(tip!.closest('dialog')).toBe(dialog)
    expect(tip!.hasAttribute('data-in-dialog')).toBe(true)

    wrapper.unmount()
    dialog.remove()
  })

  it('控件被禁用时通过 anchor 悬停外壳仍能触发提示', async () => {
    const wrapper = mount(StudioTooltip, {
      props: { content: '当前操作暂不可用', anchor: true, delay: 0 },
      slots: { default: '<button type="button" disabled>不可用</button>' },
      attachTo: document.body,
    })
    const anchor = wrapper.find('.studio-tooltip-anchor')
    await anchor.trigger('pointermove')
    await flushPromises()

    const tip = document.querySelector('.studio-tooltip')
    expect(tip).not.toBeNull()
    expect(tip!.textContent).toContain('当前操作暂不可用')
    wrapper.unmount()
  })

  it('控件被禁用时通过 anchor 键盘聚焦外壳也能触发提示', async () => {
    const wrapper = mount(StudioTooltip, {
      props: { content: '键盘提示说明', anchor: true },
      slots: { default: '<button type="button" disabled>不可用</button>' },
      attachTo: document.body,
    })
    await flushPromises()
    const anchor = wrapper.find('.studio-tooltip-anchor')
    expect(anchor.attributes('tabindex')).toBe('0')
    await anchor.trigger('focus')
    await flushPromises()

    const tip = document.querySelector('.studio-tooltip')
    expect(tip).not.toBeNull()
    expect(tip!.textContent).toContain('键盘提示说明')
    wrapper.unmount()
  })
  it('子元素使用 aria-disabled="true" 时外壳同样识别为禁用态并提供聚焦与悬停支持', async () => {
    const wrapper = mount(StudioTooltip, {
      props: { content: '无障碍禁用说明', anchor: true },
      slots: { default: '<div role="button" aria-disabled="true">自定义按钮</div>' },
      attachTo: document.body,
    })
    await flushPromises()
    const anchor = wrapper.find('.studio-tooltip-anchor')
    expect(anchor.attributes('tabindex')).toBe('0')
    expect(anchor.attributes('aria-disabled')).toBe('true')

    await anchor.trigger('focus')
    await flushPromises()
    const tip = document.querySelector('.studio-tooltip')
    expect(tip).not.toBeNull()
    expect(tip!.textContent).toContain('无障碍禁用说明')
    wrapper.unmount()
  })

  it('子元素动态切换 disabled 属性时通过 MutationObserver 实时同步 anchor 外壳状态', async () => {
    const wrapper = mount(StudioTooltip, {
      props: { content: '动态状态提示', anchor: true },
      slots: { default: '<button type="button">操作</button>' },
      attachTo: document.body,
    })
    await flushPromises()
    const anchor = wrapper.find('.studio-tooltip-anchor')
    expect(anchor.attributes('tabindex')).toBeUndefined()

    const btn = wrapper.find('button').element as HTMLButtonElement
    btn.disabled = true
    await flushPromises()

    expect(anchor.attributes('tabindex')).toBe('0')
    expect(anchor.attributes('aria-disabled')).toBe('true')

    btn.disabled = false
    await flushPromises()

    expect(anchor.attributes('tabindex')).toBeUndefined()
    expect(anchor.attributes('aria-disabled')).toBeUndefined()
    wrapper.unmount()
  })

  it('动态切换 anchor 属性时自动建立或注销外壳能力', async () => {
    const wrapper = mount(StudioTooltip, {
      props: { content: '动态 anchor 提示', anchor: false },
      slots: { default: '<button type="button" disabled>不可用</button>' },
      attachTo: document.body,
    })
    await flushPromises()
    const anchor = wrapper.find('.studio-tooltip-anchor')
    expect(anchor.attributes('data-anchor')).toBeUndefined()
    expect(anchor.attributes('tabindex')).toBeUndefined()

    await wrapper.setProps({ anchor: true })
    await flushPromises()

    expect(anchor.attributes('data-anchor')).toBeDefined()
    expect(anchor.attributes('tabindex')).toBe('0')

    await wrapper.setProps({ anchor: false })
    await flushPromises()

    expect(anchor.attributes('data-anchor')).toBeUndefined()
    expect(anchor.attributes('tabindex')).toBeUndefined()
    wrapper.unmount()
  })
});
