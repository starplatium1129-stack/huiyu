import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import LocalSetupPanel from './LocalSetupPanel.vue'
import type { LocalSetupResponse } from '../../types/local-setup'

const fixture = vi.hoisted(() => ({ local: true, desktop: false, getStatus: vi.fn(), getWorkspace: vi.fn(), setWorkspace: vi.fn() }))
vi.mock('../utils/runtimeEnvironment.ts', () => ({ isLocalStudioHost: () => fixture.local }))
vi.mock('../api/localSetupApi.ts', () => ({ localSetupApi: { getStatus: fixture.getStatus } }))
vi.mock('../platform/desktop/capabilities.ts', () => ({ getDesktopCapabilities: () => fixture.desktop ? { getWorkspace: fixture.getWorkspace, setWorkspace: fixture.setWorkspace } : undefined }))

function complete(): LocalSetupResponse {
  return { ok: true, checkedAt: 1_791_083_000_000,
    workspace: { path: 'D:\\AI', state: 'present' },
    comfy: { path: 'D:\\AI\\ComfyUI', installation: 'present', layout: 'unrecognized', host: 'http://127.0.0.1:8188', connection: 'online' },
    models: ['anima-aesthetic-v1.1', 'qwen-encoder', 'qwen-vae'].map(id => ({ id, label: id, path: `D:\\AI\\ComfyUI\\models\\${id}`, state: 'present', bytes: 10, required: true })),
    nodes: { state: 'checked', required: ['ImageSharpenKJ'], missing: [] },
    hardware: { state: 'unknown', devices: [], ramBytes: null } }
}
function deferred() {
  let resolve!: (value: LocalSetupResponse) => void
  const promise = new Promise<LocalSetupResponse>(finish => { resolve = finish })
  return { promise, resolve }
}
function render() {
  return mount(LocalSetupPanel, { global: { stubs: { ArchiveIcon: true, RouterLink: { template: '<a><slot /></a>' },
    CompanionWorkspaceSettings: { name: 'CompanionWorkspaceSettings', props: ['open', 'modelValue', 'saving', 'error'], emits: ['save', 'close', 'update:modelValue'], template: '<div />' } } } })
}
beforeEach(() => {
  fixture.local = true; fixture.desktop = false
  fixture.getStatus.mockReset().mockResolvedValue(complete())
  fixture.getWorkspace.mockReset().mockResolvedValue({ root: 'E:\\NewAI', exists: true })
  fixture.setWorkspace.mockReset().mockResolvedValue({ root: 'E:\\NewAI' })
})
afterEach(() => vi.restoreAllMocks())

describe('first local setup panel', () => {
  it('performs one mount read; suppresses repeat clicks, cancels late results and clears stale success on failure', async () => {
    const first = deferred()
    fixture.getStatus.mockReturnValueOnce(first.promise)
    const wrapper = render()
    await wrapper.find('.setup-heading button').trigger('click')
    expect(fixture.getStatus).toHaveBeenCalledTimes(1)
    const signal = fixture.getStatus.mock.calls[0][0].signal as AbortSignal
    await wrapper.findAll('button').find(button => button.text() === '取消检查')!.trigger('click')
    expect(signal.aborted).toBe(true)
    first.resolve(complete()); await flushPromises()
    expect(wrapper.find('.setup-result').text()).toBe('检查已取消')
    await wrapper.find('.setup-heading button').trigger('click'); await flushPromises()
    expect(wrapper.find('.setup-result').attributes('data-state')).toBe('checked')
    fixture.getStatus.mockRejectedValueOnce(new Error('读取失败'))
    await wrapper.find('.setup-heading button').trigger('click'); await flushPromises()
    expect(wrapper.find('.setup-result').attributes('data-state')).toBe('pending')
    expect(wrapper.find('.setup-overview').exists()).toBe(false)
    expect(wrapper.find('[role="alert"]').text()).toBe('读取失败')
    const last = deferred(); fixture.getStatus.mockReturnValueOnce(last.promise)
    await wrapper.find('.setup-heading button').trigger('click')
    const lastSignal = fixture.getStatus.mock.calls.at(-1)![0].signal as AbortSignal
    wrapper.unmount()
    expect(lastSignal.aborted).toBe(true)
    last.resolve(complete()); await flushPromises()
  })
  it('makes no local request and exposes no workspace controls to remote viewers', async () => {
    fixture.local = false; fixture.desktop = true
    const wrapper = render(); await flushPromises()
    expect(fixture.getStatus).not.toHaveBeenCalled()
    expect(wrapper.findAll('button')).toHaveLength(0)
    expect(wrapper.findComponent({ name: 'CompanionWorkspaceSettings' }).exists()).toBe(false)
    wrapper.unmount()
  })
  it('shows recommendation gaps without declaring existing alternative models unusable', async () => {
    const value = complete(); value.models[0].state = 'missing'
    value.models.push({ id: 'other', label: 'Existing model', path: 'D:\\AI\\ComfyUI\\models\\other', state: 'present', bytes: 42, required: false })
    fixture.getStatus.mockResolvedValue(value)
    const wrapper = render(); await flushPromises()
    expect(wrapper.find('.setup-result').attributes('data-state')).toBe('pending')
    expect(wrapper.find('.setup-next').text()).toContain('已有其他底模仍可按原配置使用')
    expect(wrapper.text()).toContain('Existing model')
    expect(wrapper.text()).toContain('设备报告未知')
    expect(wrapper.find('details').attributes('open')).toBeUndefined()
    wrapper.unmount()
  })
  it('saves a workspace only on explicit save and retains the active runtime evidence until restart', async () => {
    fixture.desktop = true
    const wrapper = render(); await flushPromises()
    await wrapper.findAll('button').find(button => button.text().includes('选择 AI 工作区'))!.trigger('click'); await flushPromises()
    const dialog = wrapper.findComponent({ name: 'CompanionWorkspaceSettings' })
    expect(dialog.props('modelValue')).toBe('E:\\NewAI')
    dialog.vm.$emit('close'); await flushPromises()
    expect(fixture.setWorkspace).not.toHaveBeenCalled()
    await wrapper.findAll('button').find(button => button.text().includes('选择 AI 工作区'))!.trigger('click'); await flushPromises()
    dialog.vm.$emit('save'); dialog.vm.$emit('save'); await flushPromises()
    expect(fixture.setWorkspace).toHaveBeenCalledTimes(1)
    expect(fixture.setWorkspace).toHaveBeenCalledWith('E:\\NewAI')
    expect(fixture.getStatus).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('重启应用后生效')
    expect(wrapper.text()).toContain('D:\\AI')
    wrapper.unmount()
  })
})
