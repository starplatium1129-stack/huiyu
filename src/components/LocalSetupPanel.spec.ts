import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import LocalSetupPanel from './LocalSetupPanel.vue'
import StudioSelect from './ui/StudioSelect.vue'
import type { LocalSetupResponse, LocalSetupVerificationResult, LocalSetupDownloadResult } from '../../types/local-setup'

const fixture = vi.hoisted(() => ({ local: true, desktop: false, getStatus: vi.fn(), verifyModel: vi.fn(), downloadModel: vi.fn(), getWorkspace: vi.fn(), setWorkspace: vi.fn(), pickWorkspace: vi.fn() }))
vi.mock('../utils/runtimeEnvironment.ts', () => ({ isLocalStudioHost: () => fixture.local }))
vi.mock('../api/localSetupApi.ts', () => ({ localSetupApi: { getStatus: fixture.getStatus, verifyModel: fixture.verifyModel, downloadModel: fixture.downloadModel } }))
vi.mock('../platform/desktop/capabilities.ts', () => ({ getDesktopCapabilities: () => fixture.desktop ? { getWorkspace: fixture.getWorkspace, setWorkspace: fixture.setWorkspace, pickWorkspace: fixture.pickWorkspace } : undefined }))
vi.mock('../composables/useFluidDialog', () => ({ useFluidDialog: () => ({ open: vi.fn(), close: vi.fn() }) }))

function complete(): LocalSetupResponse {
  return { ok: true, checkedAt: 1_791_083_000_000,
    workspace: { path: 'D:\\AI', state: 'present' },
    comfy: { path: 'D:\\AI\\ComfyUI', installation: 'present', layout: 'unrecognized', host: 'http://127.0.0.1:8188', connection: 'online' },
    models: ['anima-aesthetic-v1.1', 'qwen-encoder', 'qwen-vae'].map(id => ({ id, label: id, path: `D:\\AI\\ComfyUI\\models\\${id}`, state: 'present', bytes: 10, required: true, preparation: { url: 'https://huggingface.co/circlestone-labs/Anima/resolve/' + 'a'.repeat(40) + '/model.safetensors', modelCardUrl: 'https://huggingface.co/circlestone-labs/Anima', licenseUrl: 'https://huggingface.co/circlestone-labs/Anima/blob/' + 'a'.repeat(40) + '/LICENSE.md', upstreamLicenseUrl: null, revision: 'a'.repeat(40), expectedBytes: 10, sha256: 'b'.repeat(64) } })),
    nodes: { state: 'checked', required: ['ImageSharpenKJ'], missing: [] },
    hardware: { state: 'unknown', devices: [], ramBytes: null } }
}
function deferred() {
  let resolve!: (value: LocalSetupResponse) => void
  const promise = new Promise<LocalSetupResponse>(finish => { resolve = finish })
  return { promise, resolve }
}
function render(realSettings = false) {
  return mount(LocalSetupPanel, { global: { stubs: { ArchiveIcon: true, Teleport: true, RouterLink: { template: '<a><slot /></a>' },
    CompanionWorkspaceSettings: realSettings ? false : { name: 'CompanionWorkspaceSettings', props: ['open', 'modelValue', 'saving', 'error'], emits: ['save', 'close', 'update:modelValue'], template: '<div />' } } } })
}
beforeEach(() => {
  fixture.local = true; fixture.desktop = false
  fixture.getStatus.mockReset().mockResolvedValue(complete())
  fixture.verifyModel.mockReset()
  fixture.downloadModel.mockReset()
  fixture.getWorkspace.mockReset().mockResolvedValue({ root: 'E:\\NewAI', exists: true, activeRoot: 'D:\\AI', restartRequired: true })
  fixture.setWorkspace.mockReset().mockResolvedValue({ root: 'F:\\ChosenAI', exists: true, activeRoot: 'D:\\AI', restartRequired: true })
  fixture.pickWorkspace.mockReset().mockResolvedValue('F:\\ChosenAI')
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
    expect(wrapper.find('.setup-overview').exists()).toBe(true)
    expect(wrapper.find('[role="alert"]').text()).toBe('读取失败')
    expect(wrapper.find('.setup-next').text()).toContain('上次结果')
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
    value.models.push({ id: 'other', label: 'Existing model', path: 'D:\\AI\\ComfyUI\\models\\other', state: 'present', bytes: 42, required: false, preparation: null })
    fixture.getStatus.mockResolvedValue(value)
    const wrapper = render(); await flushPromises()
    expect(wrapper.find('.setup-result').attributes('data-state')).toBe('pending')
    expect(wrapper.find('.setup-next').text()).toContain('已有其他底模仍可按原配置使用')
    expect(wrapper.text()).toContain('Existing model')
    expect(wrapper.text()).toContain('设备报告未知')
    expect(wrapper.find('details').attributes('open')).toBeUndefined()
    wrapper.unmount()
  })
  it('keeps downloads behind explicit plan review and resets review when the route changes', async () => {
    const value = complete(); value.models[0].bytes = 3
    fixture.getStatus.mockResolvedValue(value)
    const wrapper = render(); await flushPromises()
    expect(wrapper.find('.setup-result').attributes('data-state')).toBe('pending')
    expect(wrapper.find('.preparation').text()).toContain('大小不符')
    expect(wrapper.find('.download-checklist').exists()).toBe(false)
    const confirm = wrapper.findAll('button').find(button => button.text() === '查看准备清单')!
    expect(confirm.attributes('disabled')).toBeDefined()
    await wrapper.find('.preparation-ack input').setValue(true)
    await confirm.trigger('click')
    expect(wrapper.find('.download-checklist').findAll('a')).toHaveLength(3)
    expect(wrapper.find('.download-checklist').text()).toContain("Get-FileHash -LiteralPath 'D:\\AI")
    expect(fixture.getStatus).toHaveBeenCalledTimes(1)
    await wrapper.getComponent(StudioSelect).setValue('portable')
    expect(wrapper.find('.download-checklist').exists()).toBe(false)
    expect(confirm.attributes('disabled')).toBeDefined()
    await wrapper.find('.preparation-ack input').setValue(true)
    await confirm.trigger('click')
    await wrapper.find('.preparation-ack input').setValue(false)
    expect(wrapper.find('.download-checklist').exists()).toBe(false)
    await wrapper.find('.preparation-ack input').setValue(true)
    await confirm.trigger('click')
    await wrapper.findAll('button').find(button => button.text() === '放置后重新检查')!.trigger('click')
    await flushPromises()
    expect(fixture.getStatus).toHaveBeenCalledTimes(2)
    expect(wrapper.find('.download-checklist').exists()).toBe(false)
    wrapper.unmount()
  })
  it('hashes only on request, cancels late results and keeps a failed digest out of readiness', async () => {
    let finish!: (result: LocalSetupVerificationResult) => void
    fixture.verifyModel.mockImplementationOnce((_id, options) => {
      options.onProgress({ type: 'progress', modelId: 'anima-aesthetic-v1.1', bytesRead: 5, expectedBytes: 10 })
      return new Promise<LocalSetupVerificationResult>(resolve => { finish = resolve })
    })
    const wrapper = render(); await flushPromises()
    expect(fixture.verifyModel).not.toHaveBeenCalled()
    const button = wrapper.findAll('button').find(button => button.text() === '校验 anima-aesthetic-v1.1 的 SHA-256')!
    await button.trigger('click'); await button.trigger('click')
    expect(fixture.verifyModel).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('50%')
    const signal = fixture.verifyModel.mock.calls[0][1].signal as AbortSignal
    await wrapper.findAll('button').find(button => button.text() === '取消校验')!.trigger('click')
    expect(signal.aborted).toBe(true)
    const result: LocalSetupVerificationResult = { type: 'result', modelId: 'anima-aesthetic-v1.1', path: complete().models[0].path, state: 'hash-mismatch', bytes: 10, sha256: 'c'.repeat(64), checkedAt: 1, message: '摘要不符' }
    finish(result); await flushPromises()
    expect(wrapper.text()).toContain('已取消校验')
    expect(wrapper.text()).not.toContain('摘要不符')
    fixture.verifyModel.mockResolvedValueOnce(result)
    await button.trigger('click'); await flushPromises()
    expect(wrapper.find('.setup-result').attributes('data-state')).toBe('pending')
    expect(wrapper.find('.setup-next').text()).toContain('完整性校验未通过')
    await wrapper.find('.setup-heading button').trigger('click'); await flushPromises()
    expect(wrapper.find('.setup-result').attributes('data-state')).toBe('pending')
    expect(wrapper.find('.setup-next').text()).toContain('重新检查不会清除')
    fixture.verifyModel.mockResolvedValueOnce({ ...result, state: 'sha256-match', sha256: 'b'.repeat(64), message: '本次读取的字节一致' })
    await wrapper.findAll('button').find(button => button.text() === '校验 anima-aesthetic-v1.1 的 SHA-256')!.trigger('click'); await flushPromises()
    expect(wrapper.find('[data-verification="sha256-match"]').exists()).toBe(true)
    expect(wrapper.find('.setup-result').attributes('data-state')).toBe('checked')
    fixture.verifyModel.mockImplementationOnce(() => new Promise<LocalSetupVerificationResult>(resolve => { finish = resolve }))
    await wrapper.findAll('button').find(button => button.text() === '校验 anima-aesthetic-v1.1 的 SHA-256')!.trigger('click')
    const recheck = deferred(); fixture.getStatus.mockReturnValueOnce(recheck.promise)
    await wrapper.find('.setup-heading button').trigger('click'); await flushPromises()
    expect(fixture.verifyModel.mock.lastCall![1].signal.aborted).toBe(true)
    finish(result); recheck.resolve(complete()); await flushPromises()
    expect(wrapper.find('[data-verification]').exists()).toBe(false)
    wrapper.unmount()
  })
  it('downloads explicitly, cancels without accepting late success, retries failures and rechecks after verified publication', async () => {
    fixture.desktop = true
    fixture.getWorkspace.mockResolvedValue({ root: 'D:\\AI', exists: true, activeRoot: 'D:\\AI', restartRequired: false })
    const value = complete(); value.models[0].state = 'missing'; value.models[0].bytes = null
    fixture.getStatus.mockResolvedValueOnce(value)
    const wrapper = render(); await flushPromises()
    const review = async () => { await wrapper.find('.preparation-ack input').setValue(true); await wrapper.findAll('button').find(button => button.text() === '查看准备清单')!.trigger('click') }
    expect(fixture.downloadModel).not.toHaveBeenCalled()
    await review()
    const button = () => wrapper.findAll('button').find(button => button.text().includes('anima-aesthetic-v1.1（'))!
    let finish!: (value: LocalSetupDownloadResult) => void
    fixture.downloadModel.mockImplementationOnce((_id, options) => {
      options.onProgress({ type: 'progress', modelId: 'anima-aesthetic-v1.1', phase: 'downloading', bytesRead: 5, expectedBytes: 10 })
      return new Promise<LocalSetupDownloadResult>(resolve => { finish = resolve })
    })
    await button().trigger('click'); await button().trigger('click')
    expect(fixture.downloadModel).toHaveBeenCalledTimes(1)
    expect(fixture.downloadModel.mock.calls[0][1].workspacePath).toBe('D:\\AI')
    expect(wrapper.text()).toContain('正在下载'); expect(wrapper.text()).toContain('50%')
    const preparation = wrapper.find('.preparation').element
    await wrapper.find('.setup-heading button').trigger('click'); await flushPromises()
    expect(fixture.downloadModel.mock.calls[0][1].signal.aborted).toBe(false)
    expect(wrapper.find('.preparation').element).toBe(preparation)
    expect(wrapper.text()).toContain('50%')
    fixture.getStatus.mockRejectedValueOnce(new Error('inspection unavailable'))
    await wrapper.find('.setup-heading button').trigger('click'); await flushPromises()
    expect(wrapper.find('.setup-result').attributes('data-state')).toBe('pending')
    expect(wrapper.text()).toContain('检查未完成')
    expect(fixture.downloadModel.mock.calls[0][1].signal.aborted).toBe(false)

    let failBinding!: (error: Error) => void
    fixture.getWorkspace.mockImplementationOnce(() => new Promise((_resolve, reject) => { failBinding = reject }))
    const abandonedCheck = deferred(); fixture.getStatus.mockReturnValueOnce(abandonedCheck.promise)
    await wrapper.find('.setup-heading button').trigger('click'); await flushPromises()
    await wrapper.findAll('button').find(button => button.text() === '取消检查')!.trigger('click')
    failBinding(new Error('late binding failure')); abandonedCheck.resolve(complete()); await flushPromises()
    expect(fixture.downloadModel.mock.calls[0][1].signal.aborted).toBe(false)
    expect(wrapper.text()).not.toContain('late binding failure')
    await wrapper.findAll('button').find(button => button.text() === '取消下载')!.trigger('click')
    expect(fixture.downloadModel.mock.calls[0][1].signal.aborted).toBe(true)
    const success: LocalSetupDownloadResult = { type: 'result', modelId: 'anima-aesthetic-v1.1', path: value.models[0].path, state: 'downloaded', bytes: 10, sha256: 'b'.repeat(64), code: null, checkedAt: 1, message: '下载校验通过，尚未真实出图' }
    finish(success); await flushPromises()
    expect(fixture.getStatus).toHaveBeenCalledTimes(4); expect(wrapper.text()).toContain('已有模型保留')
    fixture.downloadModel.mockResolvedValueOnce({ ...success, state: 'failed', bytes: null, sha256: null, code: 'MODEL_CONFLICT', message: '同名文件冲突' })
    await button().trigger('click'); await flushPromises()
    expect(wrapper.text()).toContain('同名文件冲突'); expect(button().text()).toContain('重试下载')
    fixture.downloadModel.mockResolvedValueOnce(success)
    await button().trigger('click'); await flushPromises()
    expect(fixture.getStatus).toHaveBeenCalledTimes(5)
    expect(wrapper.text()).toContain(success.message); expect(wrapper.find('.download-checklist').exists()).toBe(false)
    await review()
    fixture.downloadModel.mockImplementationOnce(() => new Promise<LocalSetupDownloadResult>(resolve => { finish = resolve }))
    await button().trigger('click')
    const changed = complete(); changed.models[0].preparation!.sha256 = 'd'.repeat(64)
    fixture.getStatus.mockResolvedValueOnce(changed)
    await wrapper.find('.setup-heading button').trigger('click'); await flushPromises()
    expect(fixture.downloadModel.mock.lastCall![1].signal.aborted).toBe(true)
    finish(success); await flushPromises()
    expect(fixture.getStatus).toHaveBeenCalledTimes(6)
    wrapper.unmount()
  })
  it('saves a workspace only on explicit save and retains the active runtime evidence until restart', async () => {
    fixture.desktop = true
    const wrapper = render(true); await flushPromises()
    expect(fixture.getWorkspace).toHaveBeenCalledTimes(1)
    await wrapper.find('.preparation-ack input').setValue(true)
    expect(wrapper.findAll('button').find(button => button.text() === '查看准备清单')!.attributes('disabled')).toBeDefined()
    await wrapper.findAll('button').find(button => button.text().includes('选择 AI 工作区'))!.trigger('click'); await flushPromises()
    const dialog = wrapper.findComponent({ name: 'CompanionWorkspaceSettings' })
    expect(dialog.props('modelValue')).toBe('E:\\NewAI')
    dialog.vm.$emit('close'); await flushPromises()
    expect(fixture.setWorkspace).not.toHaveBeenCalled()
    await wrapper.findAll('button').find(button => button.text().includes('选择 AI 工作区'))!.trigger('click'); await flushPromises()
    await dialog.findAll('button').find(button => button.text() === '选择文件夹')!.trigger('click'); await flushPromises()
    expect(fixture.pickWorkspace).toHaveBeenCalledWith('E:\\NewAI')
    expect(dialog.props('modelValue')).toBe('F:\\ChosenAI')
    expect(fixture.setWorkspace).not.toHaveBeenCalled()
    dialog.vm.$emit('save'); dialog.vm.$emit('save'); await flushPromises()
    expect(fixture.setWorkspace).toHaveBeenCalledTimes(1)
    expect(fixture.setWorkspace).toHaveBeenCalledWith('F:\\ChosenAI')
    expect(fixture.getStatus).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('完全退出并重启绘遇后生效')
    expect(wrapper.text()).toContain('D:\\AI')
    await wrapper.find('.preparation-ack input').setValue(true)
    expect(wrapper.findAll('button').find(button => button.text() === '查看准备清单')!.attributes('disabled')).toBeDefined()
    fixture.setWorkspace.mockResolvedValueOnce({ root: 'D:\\AI', exists: true, activeRoot: 'D:\\AI', restartRequired: false })
    await wrapper.findAll('button').find(button => button.text().includes('选择 AI 工作区'))!.trigger('click'); await flushPromises()
    dialog.vm.$emit('update:modelValue', 'D:\\AI'); dialog.vm.$emit('save'); await flushPromises()
    expect(wrapper.text()).toContain('当前运行时目录未改变')
    expect(wrapper.find('.setup-note[role="status"]').text()).not.toContain('重启')
    wrapper.unmount()
  })
})
