import { mount } from '@vue/test-utils'
import { expect, it } from 'vitest'
import ChatModelControls from './ChatModelControls.vue'

it('lets users disable unsupported room tools and recheck an existing local service, without acting while busy', async () => {
  const wrapper = mount(ChatModelControls, { props: { chatProvider: 'api', busy: false, ollamaOnline: false, models: [], currentModel: '', reasoning: 'off', companionTools: true, apiSettingsOpen: false, useHostConfig: false, hostApiModel: '', apiConfigured: false, apiModel: '' },
    global: { stubs: { StudioSelect: true, ArchiveIcon: true, AnimatedSelection: true, StudioTooltip: { template: '<div><slot /></div>' } }, directives: { 'content-motion': {} } } })
  try {
    wrapper.get('details').element.open = true
    await wrapper.get('details').trigger('toggle')
    expect(wrapper.text()).toContain('Gemini 3 / 2.5 Pro 不能关闭思考，选择「关」会使用低档')
    expect(wrapper.text()).toContain('Kimi K2.6 的低 / 中 / 高均为开启思考，不区分强度')
    expect(wrapper.text()).toContain('DeepSeek 开启房间工具时请关闭推理')
    const tools = () => wrapper.findAll('button').find(button => button.text().startsWith('房间工具'))!
    expect(tools().attributes('aria-pressed')).toBe('true')
    await tools().trigger('click')
    expect(wrapper.emitted('update:companion-tools')).toEqual([[false]])
    await wrapper.setProps({ busy: true })
    await tools().trigger('click')
    expect(wrapper.emitted('update:companion-tools')).toHaveLength(1)
    await wrapper.setProps({ busy: false, chatProvider: 'local', localStatusText: 'Ollama 已启动，但没有可用聊天模型' })
    expect(wrapper.text()).toContain('已启动，但没有可用聊天模型')
    const refresh = () => wrapper.findAll('button').find(button => /重新检测|检测中/.test(button.text()))!
    await refresh().trigger('click')
    expect(wrapper.emitted('refresh-local')).toHaveLength(1)
    await wrapper.setProps({ checkingLocal: true })
    expect(refresh().attributes('disabled')).toBeDefined()
  } finally { wrapper.unmount() }
})
