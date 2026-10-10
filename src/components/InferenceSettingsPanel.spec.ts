import { describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import InferenceSettingsPanel from './InferenceSettingsPanel.vue'
import InferenceSetupPanel from './InferenceSetupPanel.vue'
import { inferenceSettingsApi } from '@/api/inferenceSettingsApi'
import { inferenceSetupApi } from '@/api/inferenceSetupApi'
import { localSetupApi } from '@/api/localSetupApi'
vi.mock('@/utils/runtimeEnvironment', () => ({ isLocalStudioHost: () => true }))
vi.mock('@/api/inferenceSettingsApi', async original => ({
  ...await original<typeof import('@/api/inferenceSettingsApi')>(),
  inferenceSettingsApi: { getStatus: vi.fn(), save: vi.fn(), diagnose: vi.fn() },
}))
vi.mock('@/api/inferenceSetupApi', async original => ({
  ...await original<typeof import('@/api/inferenceSetupApi')>(),
  inferenceSetupApi: { prepareRuntime: vi.fn(), inspectModel: vi.fn(), importModel: vi.fn() },
}))
vi.mock('@/api/localSetupApi', () => ({ localSetupApi: { getOperation: vi.fn(), cancelEnvironment: vi.fn() } }))
describe('inference settings panel', () => {
  it('labels path inputs, separates readiness evidence and shows restart-needed save feedback', async () => {
    const settings = { engine: 'comfy' as const, modelsRoot: '/models', lorasRoot: '/loras', python: '/python', worker: '/worker' }
    const response = { ok: true as const, active: settings, configured: settings, restartRequired: false, environmentOverrides: [] }
    vi.mocked(inferenceSettingsApi.getStatus).mockResolvedValue({ ...response, diagnostics: {
      basis: 'configured', configuration: 'valid', files: { python: true, worker: true, modelsRoot: true, lorasRoot: false }, dependencies: 'unchecked', runtime: 'unverified', message: '',
    } })
    vi.mocked(inferenceSettingsApi.save).mockResolvedValue({ ...response, configured: { ...settings, modelsRoot: '/edited' }, restartRequired: true })
    vi.mocked(localSetupApi.getOperation).mockResolvedValue({ ok: true, operation: null })
    const wrapper = mount(InferenceSettingsPanel, { global: { stubs: { StudioSelect: true } } })
    await flushPromises()
    const input = wrapper.get('#inference-modelsRoot')
    expect(wrapper.get('label[for="inference-modelsRoot"]').text()).toBe('模型根目录')
    expect(input.attributes('aria-describedby')).toBe('inference-modelsRoot-hint')
    expect(wrapper.text()).toContain('真实出图未验证')
    expect(wrapper.text()).toContain('LoRA 目录：未找到')
    expect(inferenceSettingsApi.diagnose).not.toHaveBeenCalled()
    await input.setValue('/edited')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.get('[role="status"]').text()).toContain('重启绘遇运行时后生效')
    expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeDefined()
    const setup = wrapper.getComponent(InferenceSetupPanel)
    await setup.get('#native-base-python').setValue('/python')
    await setup.get('#native-wheelhouse').setValue('/wheels')
    await setup.get('#native-workspace').setValue('/ai')
    const prepareButton = setup.findAll('button').find(button => button.text() === '准备离线运行库')!
    expect(prepareButton.attributes('disabled')).toBeDefined()
    await setup.findAll('input[type="checkbox"]')[0].setValue(true)
    const preparedPaths = { python: '/prepared/python', worker: '/prepared/worker', modelsRoot: '/prepared/models', lorasRoot: '/prepared/loras' }
    const operation = { id: 'native-1', kind: 'prepare-inference-runtime' as const, label: '', status: 'completed' as const, stageIndex: 0, stages: [], message: '完成', startedAt: 1, finishedAt: 2, error: '', preparedPaths }
    vi.mocked(inferenceSetupApi.prepareRuntime).mockResolvedValue({ ok: true, operation, preparedPaths })
    vi.mocked(localSetupApi.getOperation).mockResolvedValueOnce({ ok: true, operation: null }).mockResolvedValue({ ok: true, operation })
    await prepareButton.trigger('click')
    await flushPromises()
    expect((wrapper.get('#inference-python').element as HTMLInputElement).value).toBe('/python')
    expect(inferenceSettingsApi.save).toHaveBeenCalledTimes(1)
    await setup.findAll('button').find(button => button.text() === '填入设置')!.trigger('click')
    await flushPromises()
    expect((wrapper.get('#inference-python').element as HTMLInputElement).value).toBe('/prepared/python')
    expect(wrapper.text()).toContain('已填入路径草稿')
    expect(inferenceSettingsApi.save).toHaveBeenCalledTimes(1)
    expect(wrapper.getComponent(InferenceSetupPanel).props('configured').engine).toBe('comfy')
    wrapper.unmount()
  })
})
