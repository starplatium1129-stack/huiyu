import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import LocalSetupAutomation from './LocalSetupAutomation.vue'
import StudioSelect from './ui/StudioSelect.vue'
import { complete, deferred } from './__fixtures__/localSetup'
import { settingsRepository } from '../storage/settingsRepository'

const api = vi.hoisted(() => ({ getStatus: vi.fn(), getOperation: vi.fn(), cancelEnvironment: vi.fn(), prepareEnvironment: vi.fn(), downloadModel: vi.fn(), serviceAction: vi.fn() }))
vi.mock('../api/localSetupApi.ts', () => ({ localSetupApi: api }))
vi.mock('../api/controlApi.ts', () => ({ controlApi: api }))
function render(snapshot = complete()) {
  return mount(LocalSetupAutomation, { props: { snapshot, workspaceBlocked: false, statusConfirmed: true }, global: { stubs: { ArchiveIcon: true, RouterLink: { template: '<a><slot /></a>' } } } })
}
const operation = { id: 'existing-start', status: 'completed', message: '已启动', error: '' }
beforeEach(() => {
  vi.clearAllMocks()
  api.getStatus.mockResolvedValue(complete())
  api.serviceAction.mockResolvedValue({ ok: true, operation })
  api.getOperation.mockResolvedValue({ ok: true, operation })
  api.cancelEnvironment.mockResolvedValue({ ok: true })
})
describe('explicit existing environment recovery', () => {
  it.each(['portable', 'venv'] as const)('starts existing %s without download or preparation consent', async layout => {
    const value = complete(); value.comfy.layout = layout; value.comfy.connection = 'offline'; value.nodes.state = 'unknown'
    const wrapper = render(value)
    const start = wrapper.findAll('button').find(button => button.text() === '启动现有环境并重新检查')!
    await start.trigger('click'); await start.trigger('click'); await flushPromises()
    expect(api.serviceAction).toHaveBeenCalledExactlyOnceWith('comfy', 'start')
    expect(api.prepareEnvironment).not.toHaveBeenCalled()
    expect(api.downloadModel).not.toHaveBeenCalled()
    expect(api.getStatus).toHaveBeenCalledExactlyOnceWith({ modelId: 'anima-miaomiao-v1.6' })
    expect(wrapper.emitted('refresh')).toHaveLength(1)
    expect(wrapper.text()).toContain('生成第一张图片')
    wrapper.unmount()
  })
  it.each(['external-venv', 'unrecognized'] as const)('does not offer takeover for %s', layout => {
    const value = complete(); value.comfy.layout = layout
    const wrapper = render(value)
    expect(wrapper.findAll('button').some(button => button.text() === '启动现有环境并重新检查')).toBe(false)
    expect(api.serviceAction).not.toHaveBeenCalled()
    wrapper.unmount()
  })
  it('retains cancellation during the final check and does not accept a late ready result', async () => {
    const late = deferred(), save = vi.spyOn(settingsRepository, 'set').mockImplementation(() => {})
    api.getStatus.mockReturnValueOnce(late.promise)
    const wrapper = render()
    await wrapper.findAll('button').find(button => button.text() === '启动现有环境并重新检查')!.trigger('click'); await flushPromises()
    await wrapper.findAll('button').find(button => button.text() === '取消准备')!.trigger('click')
    late.resolve(complete()); await flushPromises()
    expect(save).not.toHaveBeenCalled()
    expect(wrapper.emitted('refresh')).toBeUndefined()
    expect(wrapper.text()).not.toContain('生成第一张图片')
    wrapper.unmount(); save.mockRestore()
  })
  it('reports missing model evidence after start and allows an explicit retry', async () => {
    const value = complete(); value.models[0].state = 'missing'
    api.getStatus.mockResolvedValueOnce(value)
    const wrapper = render()
    const start = wrapper.findAll('button').find(button => button.text() === '启动现有环境并重新检查')!
    await start.trigger('click'); await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('绘图准备尚未完成')
    expect(wrapper.text()).not.toContain('生成第一张图片')
    expect(start.attributes('disabled')).toBeUndefined()
    await start.trigger('click'); await flushPromises()
    expect(api.serviceAction).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).toContain('生成第一张图片')
    wrapper.unmount()
  })
  it('initializes from the verified CUDA variant and preserves an explicit choice across refreshes', async () => {
    const value = complete(); value.comfy.managedEnvironment = { state: 'verified', environment: 'comfy-cu126' }
    const wrapper = render(value)
    const runtime = wrapper.findAllComponents(StudioSelect).find(select => select.props('id') === 'setup-comfy-runtime')!
    expect(runtime.props('modelValue')).toBe('comfy-cu126')
    await runtime.setValue('comfy-nvidia')
    await wrapper.setProps({ snapshot: { ...value } })
    expect(runtime.props('modelValue')).toBe('comfy-nvidia')
    wrapper.unmount()
  })
  it.each(['unknown', 'mismatch'] as const)('does not invent an installed CUDA variant for %s evidence', state => {
    const value = complete(); value.comfy.managedEnvironment = { state, environment: null }; value.nodes.state = 'unknown'
    const wrapper = render(value)
    const runtime = wrapper.findAllComponents(StudioSelect).find(select => select.props('id') === 'setup-comfy-runtime')!
    expect(runtime.props('modelValue')).toBe('')
    expect(wrapper.get('.setup-buttons .btn-primary').attributes('disabled')).toBeDefined()
    expect(wrapper.findAll('button').find(button => button.text() === '启动现有环境并重新检查')!.attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })
  it.each(['workspaceBlocked', 'statusConfirmed'] as const)('blocks direct startup when %s is not confirmed', async field => {
    const wrapper = render()
    await wrapper.setProps({ [field]: field === 'workspaceBlocked' })
    expect(wrapper.findAll('button').find(button => button.text() === '启动现有环境并重新检查')!.attributes('disabled')).toBeDefined()
    expect(api.serviceAction).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})
