import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import LocalSetupAutomation from './LocalSetupAutomation.vue'
import StudioSelect from './ui/StudioSelect.vue'
import { complete, deferred, render } from './__fixtures__/localSetup'
import { settingsRepository } from '../storage/settingsRepository'
import { LOCAL_SETUP_DRAFT_SETTING, readSetupDraft, type SetupDraft, type SetupOperationKind } from '../utils/localSetupDraft'
import type { ControlActionResult, ControlOperationView } from '../types/api'

const api = vi.hoisted(() => ({ getStatus: vi.fn(), getOperation: vi.fn(), cancelEnvironment: vi.fn(), prepareEnvironment: vi.fn(), downloadModel: vi.fn(), serviceAction: vi.fn() }))
vi.mock('../api/localSetupApi.ts', () => ({ localSetupApi: api }))
vi.mock('../api/controlApi.ts', () => ({ controlApi: api }))
vi.mock('../utils/runtimeEnvironment.ts', () => ({ isLocalStudioHost: () => true }))
vi.mock('../platform/desktop/capabilities.ts', () => ({ getDesktopCapabilities: () => undefined }))
const op = (kind: SetupOperationKind = 'prepare-environment'): ControlOperationView => ({ id: 'owned-preparation', kind, status: 'running', message: '正在准备依赖', label: 'fixture', stageIndex: 0, stages: ['fixture'], startedAt: 1, finishedAt: 0, error: '' })
function saveOperation(operation = op()) {
  const draft: SetupDraft = { workspace: complete().workspace.path, modelId: 'anima-miaomiao-v1.6', chatId: '', drawing: true, loras: true, environment: 'comfy-cu126', llamaEnvironment: 'llama-cuda', operation: { id: operation.id, kind: operation.kind as SetupOperationKind } }
  settingsRepository.set(LOCAL_SETUP_DRAFT_SETTING, draft)
}
function automation(snapshot = complete()) {
  return mount(LocalSetupAutomation, { props: { snapshot, workspaceBlocked: false, statusConfirmed: true }, global: { stubs: { ArchiveIcon: true, RouterLink: { template: '<a><slot /></a>' } } } })
}
beforeEach(() => {
  vi.resetAllMocks()
  settingsRepository.remove(LOCAL_SETUP_DRAFT_SETTING)
  api.getStatus.mockResolvedValue(complete())
  api.cancelEnvironment.mockResolvedValue({ ok: true })
})
afterEach(() => { vi.useRealTimers(); settingsRepository.remove(LOCAL_SETUP_DRAFT_SETTING) })

describe('first setup reopens with workspace-bound evidence', () => {
  it.each(['cancel', 'unmount'])('does not write preferences from late readiness after %s', async disposition => {
    const value = complete(), late = deferred()
    const save = vi.spyOn(settingsRepository, 'set').mockImplementation(() => {})
    api.downloadModel.mockImplementation(async (id: string) => {
      const model = value.models.find(model => model.id === id)!
      return { type: 'result', modelId: id, path: model.path, state: 'already-present', bytes: 10, sha256: 'b'.repeat(64), code: null, checkedAt: 1, message: '已复用' }
    })
    const operation = { id: 'owned-setup', status: 'completed', message: '已启动', error: '' }
    api.serviceAction.mockResolvedValue({ ok: true, operation })
    api.getOperation.mockResolvedValue({ ok: true, operation })
    api.getStatus.mockReturnValue(late.promise)
    const wrapper = mount(LocalSetupAutomation, { props: { snapshot: value, workspaceBlocked: false, statusConfirmed: true }, global: { stubs: { ArchiveIcon: true, RouterLink: { template: '<a><slot /></a>' } } } })
    try {
      await wrapper.get('.setup-review input').setValue(true)
      await wrapper.get('.setup-buttons .btn-primary').trigger('click')
      await flushPromises()
      expect(api.getStatus).toHaveBeenCalledOnce()
      if (disposition === 'cancel') await wrapper.findAll('button').find(button => button.text() === '取消准备')!.trigger('click')
      else wrapper.unmount()
      late.resolve(value)
      await flushPromises()
      expect(save).not.toHaveBeenCalled()
      expect(wrapper.emitted('refresh')).toBeUndefined()
    } finally { if (disposition !== 'unmount') wrapper.unmount() }
  })
  it.each(['cancel', 'unmount'])('handles an operation acknowledged after %s without proceeding or losing explicit cancellation', async disposition => {
    const value = complete()
    let acknowledge!: (result: ControlActionResult) => void
    let finishCancel = () => {}
    if (disposition === 'cancel') api.cancelEnvironment.mockReturnValue(new Promise<void>(resolve => { finishCancel = resolve }))
    api.getOperation.mockResolvedValue({ ok: true, operation: { id: 'late-owned-setup', status: 'failed', message: '准备已取消', error: '准备已取消' } })
    api.serviceAction.mockReturnValue(new Promise<ControlActionResult>(resolve => { acknowledge = resolve }))
    api.downloadModel.mockImplementation(async (id: string) => {
      const model = value.models.find(model => model.id === id)!
      return { type: 'result', modelId: id, path: model.path, state: 'already-present', bytes: 10, sha256: 'b'.repeat(64), code: null, checkedAt: 1, message: '已复用' }
    })
    const wrapper = mount(LocalSetupAutomation, { props: { snapshot: value, workspaceBlocked: false, statusConfirmed: true }, global: { stubs: { ArchiveIcon: true, RouterLink: { template: '<a><slot /></a>' } } } })
    await wrapper.get('.setup-review input').setValue(true)
    await wrapper.get('.setup-buttons .btn-primary').trigger('click'); await flushPromises()
    expect(api.serviceAction).toHaveBeenCalledOnce()
    if (disposition === 'cancel') await wrapper.findAll('button').find(button => button.text() === '取消准备')!.trigger('click')
    else wrapper.unmount()
    expect(api.cancelEnvironment).not.toHaveBeenCalled()
    acknowledge({ ok: true, operation: { id: 'late-owned-setup', status: 'running', message: '准备中' } } as ControlActionResult)
    await flushPromises()
    if (disposition === 'cancel') {
      await wrapper.findAll('button').find(button => button.text() === '正在请求取消…')!.trigger('click')
      expect(api.cancelEnvironment).toHaveBeenCalledExactlyOnceWith('late-owned-setup')
      finishCancel(); await flushPromises()
    } else expect(api.cancelEnvironment).not.toHaveBeenCalled()
    expect(api.getOperation).toHaveBeenCalledTimes(disposition === 'cancel' ? 1 : 0)
    expect(api.getStatus).not.toHaveBeenCalled()
    expect(wrapper.emitted('refresh')).toBeUndefined()
    if (disposition !== 'unmount') wrapper.unmount()
  })
  it.each(['failed', 'completed'] as const)('keeps cancellation retryable and waits for a %s operation and its late cancellation receipt', async terminal => {
    vi.useFakeTimers()
    const value = complete()
    const save = vi.spyOn(settingsRepository, 'set').mockImplementation(() => {})
    api.downloadModel.mockImplementation(async (id: string) => {
      const model = value.models.find(model => model.id === id)!
      return { type: 'result', modelId: id, path: model.path, state: 'already-present', bytes: 10, sha256: 'b'.repeat(64), code: null, checkedAt: 1, message: '已复用' }
    })
    let operation = { id: 'owned-setup', status: 'running', message: '准备中', error: '' }
    api.serviceAction.mockResolvedValue({ ok: true, operation })
    api.getOperation.mockImplementation(async () => ({ ok: true, operation }))
    let finishCancel!: () => void
    api.cancelEnvironment.mockRejectedValueOnce(new Error('offline'))
      .mockImplementationOnce(() => new Promise<void>(resolve => { finishCancel = resolve }))
    const wrapper = mount(LocalSetupAutomation, { props: { snapshot: value, workspaceBlocked: false, statusConfirmed: true }, global: { stubs: { ArchiveIcon: true, RouterLink: { template: '<a><slot /></a>' } } } })
    try {
      await wrapper.get('.setup-review input').setValue(true)
      await wrapper.get('.setup-buttons .btn-primary').trigger('click'); await flushPromises()
      await wrapper.findAll('button').find(button => button.text() === '取消准备')!.trigger('click'); await flushPromises()
      expect(wrapper.get('[role="alert"]').text()).toContain('取消结果尚未确认')
      expect(wrapper.get('.setup-buttons .btn-primary').attributes('disabled')).toBeDefined()
      await vi.advanceTimersByTimeAsync(500)
      expect(api.getOperation).toHaveBeenCalledTimes(2)
      const retry = wrapper.findAll('button').find(button => button.text() === '重试取消')!
      await retry.trigger('click'); await retry.trigger('click')
      expect(api.cancelEnvironment.mock.calls).toEqual([['owned-setup'], ['owned-setup']])
      expect(retry.attributes('disabled')).toBeDefined()
      if (terminal === 'failed') {
        finishCancel(); await flushPromises()
        expect(retry.text()).toBe('等待当前步骤结束…')
        await vi.advanceTimersByTimeAsync(500)
        expect(wrapper.get('.setup-buttons .btn-primary').attributes('disabled')).toBeDefined()
      }
      operation = { ...operation, status: terminal, message: terminal === 'failed' ? '准备已取消' : '当前步骤完成', error: terminal === 'failed' ? '准备已取消' : '' }
      await vi.advanceTimersByTimeAsync(500)
      if (terminal === 'completed') {
        expect(wrapper.get('.setup-buttons .btn-primary').attributes('disabled')).toBeDefined()
        finishCancel(); await flushPromises()
      }
      expect(wrapper.get('.setup-buttons .btn-primary').attributes('disabled')).toBeUndefined()
      expect(wrapper.get('[role="alert"]').text()).toContain(terminal === 'failed' ? '准备已取消' : '后续准备已停止')
      expect(wrapper.text()).not.toContain('取消结果尚未确认')
      expect(wrapper.text()).not.toContain('生成第一张图片')
      expect(api.getStatus).not.toHaveBeenCalled()
      expect(save).not.toHaveBeenCalled()
    } finally { wrapper.unmount(); vi.useRealTimers() }
  })

  it('retains an uncertain operation for status retry without cancelling a replacement operation', async () => {
    const value = complete()
    api.downloadModel.mockImplementation(async (id: string) => {
      const model = value.models.find(model => model.id === id)!
      return { type: 'result', modelId: id, path: model.path, state: 'already-present', bytes: 10, sha256: 'b'.repeat(64), code: null, checkedAt: 1, message: '已复用' }
    })
    api.serviceAction.mockResolvedValue({ ok: true, operation: { id: 'owned-setup', status: 'running' } })
    api.getOperation.mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ ok: true, operation: { id: 'replacement', status: 'running' } })
    const wrapper = mount(LocalSetupAutomation, { props: { snapshot: value, workspaceBlocked: false, statusConfirmed: true }, global: { stubs: { ArchiveIcon: true, RouterLink: { template: '<a><slot /></a>' } } } })
    try {
      await wrapper.get('.setup-review input').setValue(true)
      await wrapper.get('.setup-buttons .btn-primary').trigger('click'); await flushPromises()
      expect(wrapper.get('[role="alert"]').text()).toContain('状态尚未确认')
      expect(wrapper.get('.setup-buttons .btn-primary').attributes('disabled')).toBeDefined()
      await wrapper.findAll('button').find(button => button.text() === '重新检查状态')!.trigger('click'); await flushPromises()
      expect(wrapper.get('[role="alert"]').text()).toContain('操作状态已改变')
      expect(wrapper.get('.setup-buttons .btn-primary').attributes('disabled')).toBeUndefined()
      expect(api.cancelEnvironment).not.toHaveBeenCalled()
      expect(api.getStatus).not.toHaveBeenCalled()
    } finally { wrapper.unmount() }
  })


  it('keeps the interrupted cu126 selection, requires fresh consent and retries the same download', async () => {
    const value = complete(); value.comfy.installation = 'missing'; value.nodes.state = 'unknown'
    value.models.push({ ...value.models[0], id: 'runtime-comfy-cu126', kind: 'runtime', required: false },
      { ...value.models[0], id: 'anima-base-v1.0', required: false },
      { ...value.models[0], id: 'chat-qwen-27b-iq3', kind: 'chat', required: false })
    api.downloadModel.mockImplementation((_id, options) => new Promise(resolve => options.signal.addEventListener('abort', () => resolve({ state: 'downloaded' }), { once: true })))
    const first = automation(value)
    await first.findAllComponents(StudioSelect).find(select => select.props('id') === 'setup-image-model')!.setValue('anima-base-v1.0')
    await first.findAllComponents(StudioSelect).find(select => select.props('id') === 'setup-chat-model')!.setValue('chat-qwen-27b-iq3')
    await first.findAllComponents(StudioSelect).find(select => select.props('id') === 'setup-comfy-runtime')!.setValue('comfy-cu126')
    await first.findAll('input[type="checkbox"]')[1].setValue(false)
    await first.get('.setup-review input').setValue(true)
    await first.get('.setup-buttons .btn-primary').trigger('click'); await flushPromises()
    expect(api.downloadModel.mock.calls[0][0]).toBe('runtime-comfy-cu126')
    await first.findAll('button').find(button => button.text() === '取消准备')!.trigger('click'); await flushPromises()
    first.unmount()
    const reopened = automation(value)
    expect(reopened.findAllComponents(StudioSelect).find(select => select.props('id') === 'setup-comfy-runtime')!.props('modelValue')).toBe('comfy-cu126')
    expect(reopened.findAllComponents(StudioSelect).find(select => select.props('id') === 'setup-image-model')!.props('modelValue')).toBe('anima-base-v1.0')
    expect(reopened.findAllComponents(StudioSelect).find(select => select.props('id') === 'setup-chat-model')!.props('modelValue')).toBe('chat-qwen-27b-iq3')
    expect(reopened.emitted('model-selected')?.[0]).toEqual(['anima-base-v1.0'])
    expect((reopened.findAll('input[type="checkbox"]')[1].element as HTMLInputElement).checked).toBe(false)
    expect((reopened.get('.setup-review input').element as HTMLInputElement).checked).toBe(false)
    expect(api.downloadModel).toHaveBeenCalledOnce()
    expect(api.prepareEnvironment).not.toHaveBeenCalled()
    await reopened.get('.setup-review input').setValue(true)
    await reopened.get('.setup-buttons .btn-primary').trigger('click'); await flushPromises()
    expect(api.downloadModel.mock.calls.map(call => call[0])).toEqual(['runtime-comfy-cu126', 'runtime-comfy-cu126'])
    reopened.unmount(); await flushPromises()
  })

  it('retries a failed runtime download through preparation and startup but waits for fresh readiness', async () => {
    const value = complete(), checked = deferred(), calls: string[] = []
    value.comfy.installation = 'missing'; value.nodes.state = 'unknown'
    let corrupt = true
    api.downloadModel.mockImplementation(async (id: string) => {
      calls.push(id)
      const model = value.models.find(item => item.id === id)!
      if (corrupt && id === 'runtime-kjnodes') return { type: 'result', modelId: id, path: model.path,
        state: 'failed', code: 'HASH_MISMATCH', message: '摘要不符，请重试' }
      return { type: 'result', modelId: id, path: model.path, state: 'downloaded', bytes: 10,
        sha256: 'b'.repeat(64), code: null, checkedAt: 1, message: '已校验' }
    })
    let operation = { ...op(), status: 'completed' as const }
    api.prepareEnvironment.mockImplementation(async () => { calls.push('prepare'); return { ok: true, operation } })
    api.serviceAction.mockImplementation(async () => {
      calls.push('start'); operation = { ...op('comfy-start'), id: 'owned-start', status: 'completed' }
      return { ok: true, operation }
    })
    api.getOperation.mockImplementation(async () => ({ ok: true, operation }))
    api.getStatus.mockImplementation(() => { calls.push('readiness'); return checked.promise })
    const wrapper = automation(value)
    try {
      await wrapper.get('.setup-review input').setValue(true)
      await wrapper.get('.setup-buttons .btn-primary').trigger('click'); await flushPromises()
      expect(calls).toEqual(['runtime-comfy-nvidia', 'runtime-kjnodes'])
      expect(wrapper.get('[role="alert"]').text()).toContain('摘要不符')
      expect(api.prepareEnvironment).not.toHaveBeenCalled()
      expect(api.serviceAction).not.toHaveBeenCalled()
      expect(wrapper.text()).not.toContain('生成第一张图片')
      expect(wrapper.get('.setup-buttons .btn-primary').attributes('disabled')).toBeUndefined()
      corrupt = false; calls.length = 0
      await wrapper.get('.setup-buttons .btn-primary').trigger('click'); await flushPromises()
      expect(calls).toEqual(['runtime-comfy-nvidia', 'runtime-kjnodes', 'runtime-anima-teacache', 'prepare',
        'anima-miaomiao-v1.6', 'qwen-encoder', 'qwen-vae', 'L_NENE_V21_ANIMA', 'L_NAT_V21_ANIMA', 'start', 'readiness'])
      expect(api.prepareEnvironment).toHaveBeenCalledExactlyOnceWith('comfy-nvidia', value.workspace.path)
      expect(api.serviceAction).toHaveBeenCalledExactlyOnceWith('comfy', 'start')
      expect(wrapper.text()).not.toContain('生成第一张图片')
      checked.resolve(complete()); await flushPromises()
      expect(wrapper.text()).toContain('生成第一张图片')
      expect(wrapper.emitted('refresh')).toHaveLength(1)
    } finally { wrapper.unmount() }
  })

  it.each(['prepare-environment', 'comfy-start', 'llama-start'] as const)('recovers owned %s, cancels only its ID, and rechecks real status when it settles', async kind => {
    vi.useFakeTimers()
    let operation = op(kind); saveOperation(operation)
    api.getOperation.mockImplementation(async () => ({ ok: true, operation }))
    const wrapper = render(); await flushPromises()
    const cancel = wrapper.findAll('button').find(button => button.text() === '取消准备')!
    expect(cancel.attributes('disabled')).toBeUndefined()
    expect(wrapper.text()).toContain('正在准备依赖')
    await cancel.trigger('click'); await flushPromises()
    expect(api.cancelEnvironment).toHaveBeenCalledExactlyOnceWith(operation.id)
    const before = api.getStatus.mock.calls.length
    operation = { ...operation, status: 'failed', error: '准备已取消' }
    await vi.advanceTimersByTimeAsync(500); await flushPromises()
    expect(api.getStatus.mock.calls.length).toBe(before + 1)
    expect(wrapper.text()).toContain('准备已取消')
    expect(readSetupDraft(complete().workspace.path)?.operation).toBeUndefined()
    expect(api.prepareEnvironment).not.toHaveBeenCalled()
    expect(api.downloadModel).not.toHaveBeenCalled()
    expect(api.serviceAction).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('reads fresh readiness after a recovered step completes instead of assuming preparation succeeded', async () => {
    saveOperation(op('comfy-start'))
    api.getOperation.mockResolvedValue({ ok: true, operation: { ...op('comfy-start'), status: 'completed' } })
    const checked = complete(); checked.comfy.connection = 'offline'
    api.getStatus.mockResolvedValueOnce(complete()).mockResolvedValue(checked)
    const wrapper = render(); await flushPromises()
    expect(api.getStatus).toHaveBeenCalledTimes(2)
    expect(wrapper.get('.setup-result').attributes('data-state')).toBe('pending')
    expect(wrapper.text()).not.toContain('生成第一张图片')
    expect(api.serviceAction).not.toHaveBeenCalled()
    expect(api.downloadModel).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it.each(['id', 'kind'] as const)('does not adopt or cancel another operation with a changed %s', async field => {
    saveOperation()
    api.getOperation.mockResolvedValue({ ok: true, operation: { ...op(), [field]: field === 'id' ? 'other' : 'voice-start' } })
    const wrapper = automation(); await flushPromises()
    expect(wrapper.text()).toContain('上次步骤已结束或改变')
    expect(wrapper.findAll('button').some(button => button.text() === '取消准备')).toBe(false)
    expect(api.cancelEnvironment).not.toHaveBeenCalled()
    expect(readSetupDraft(complete().workspace.path)?.operation).toBeUndefined()
    wrapper.unmount()
  })

  it('keeps an unconfirmed recovery retryable without making cancellation available', async () => {
    saveOperation()
    api.getOperation.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ ok: true, operation: { ...op(), status: 'completed' } })
    const wrapper = automation(); await flushPromises()
    expect(wrapper.findAll('button').find(button => button.text() === '取消准备')!.attributes('disabled')).toBeDefined()
    await wrapper.findAll('button').find(button => button.text() === '重新检查状态')!.trigger('click'); await flushPromises()
    expect(wrapper.emitted('refresh')).toHaveLength(1)
    expect(wrapper.text()).toContain('后续准备需重新确认清单')
    expect(api.cancelEnvironment).not.toHaveBeenCalled()
    expect(api.prepareEnvironment).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('does not reuse a different workspace draft and prefers a verified installation on reopening', async () => {
    saveOperation()
    const other = complete(); other.workspace.path = 'E:\\OtherAI'
    const unrelated = automation(other); await flushPromises()
    expect(api.getOperation).not.toHaveBeenCalled()
    expect(unrelated.findAllComponents(StudioSelect).find(select => select.props('id') === 'setup-comfy-runtime')!.props('modelValue')).toBe('')
    unrelated.unmount()
    const installed = complete(); installed.comfy.managedEnvironment = { state: 'verified', environment: 'comfy-nvidia' }
    api.getOperation.mockResolvedValue({ ok: true, operation: null })
    const wrapper = automation(installed); await flushPromises()
    const runtime = wrapper.findAllComponents(StudioSelect).find(select => select.props('id') === 'setup-comfy-runtime')!
    expect(runtime.props('modelValue')).toBe('comfy-nvidia')
    await runtime.setValue('comfy-cu126')
    await wrapper.setProps({ snapshot: { ...installed } })
    expect(runtime.props('modelValue')).toBe('comfy-cu126')
    await wrapper.setProps({ snapshot: other })
    expect(runtime.props('modelValue')).toBe('')
    wrapper.unmount()
  })

  it('reattaches an acknowledged owned startup after the original page has already left', async () => {
    let acknowledge!: (result: unknown) => void
    api.serviceAction.mockReturnValue(new Promise(resolve => { acknowledge = resolve }))
    api.getOperation.mockResolvedValue({ ok: true, operation: { ...op('comfy-start'), status: 'completed' } })
    const first = automation()
    await first.findAll('button').find(button => button.text() === '启动现有环境并重新检查')!.trigger('click')
    first.unmount()
    const reopened = automation()
    acknowledge({ ok: true, operation: op('comfy-start') }); await flushPromises()
    expect(reopened.emitted('refresh')).toHaveLength(1)
    expect(reopened.text()).toContain('上次步骤已完成')
    expect(api.cancelEnvironment).not.toHaveBeenCalled()
    expect(api.serviceAction).toHaveBeenCalledOnce()
    reopened.unmount()
  })
})
