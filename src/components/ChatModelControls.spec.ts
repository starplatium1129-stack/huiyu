import { mount } from '@vue/test-utils'
import { expect, it } from 'vitest'
import ChatModelControls from './ChatModelControls.vue'

it('lets users disable unsupported room tools and recheck an existing local service, without acting while busy', async () => {
  const wrapper = mount(ChatModelControls, { props: { chatProvider: 'api', busy: false, ollamaOnline: false, models: [], currentModel: '', reasoning: 'off', companionTools: true, apiSettingsOpen: false, useHostConfig: false, hostApiModel: '', apiConfigured: false, apiModel: '' },
    global: { stubs: { StudioSelect: true, ArchiveIcon: true, AnimatedSelection: true, StudioTooltip: { template: '<div><slot /></div>' } }, directives: { 'content-motion': {} } } })
  try {
    wrapper.get('details').element.open = true
    await wrapper.get('details').trigger('toggle')
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
