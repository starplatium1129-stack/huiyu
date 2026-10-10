import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, ref } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { ApiClientError } from '@/api/client'
import { localSetupApi } from '@/api/localSetupApi'
import type { InferenceSettings } from '@/api/inferenceSettingsApi'
import type { InferenceSetupApi, InferenceSetupOperation, InferenceSetupResult, InferenceModelInspection } from '@/api/inferenceSetupApi'
import { useInferenceSetup } from './useInferenceSetup'
vi.mock('@/utils/runtimeEnvironment', () => ({ isLocalStudioHost: () => true }))
vi.mock('@/api/localSetupApi', () => ({ localSetupApi: { getOperation: vi.fn(), cancelEnvironment: vi.fn() } }))
const paths = { python: '/ai/inference/venv/bin/python', worker: '/worker.py', modelsRoot: '/ai/inference/models', lorasRoot: '/ai/inference/loras' }
const input = { basePython: '/python', wheelhouse: '/wheels', workspacePath: '/ai', reviewed: true as const }
const plan: InferenceModelInspection = { ok: true, planOnly: true, scope: 'layout-only', readyForInference: false, sourceDir: '/source', targetDir: '/saved-models/anima-miaomiao-v1.6', fileCount: 8, totalBytes: 200 }
function operation(status: InferenceSetupOperation['status'] = 'running', overrides: Partial<InferenceSetupOperation> = {}): InferenceSetupOperation {
  return { id: 'native-1', kind: 'prepare-inference-runtime', status, message: '处理中', error: '', startedAt: 1, finishedAt: 0, stageIndex: 0, stages: ['准备'], label: '准备运行库', ...input, preparedPaths: paths, ...overrides }
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (cause: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
const scopes: ReturnType<typeof effectScope>[] = []
function setup(overrides: Partial<InferenceSetupApi> = {}) {
  const api: InferenceSetupApi = { prepareRuntime: vi.fn().mockResolvedValue({ ok: true, operation: operation(), preparedPaths: paths }), inspectModel: vi.fn().mockResolvedValue(plan), importModel: vi.fn(), ...overrides }
  const configured = ref<InferenceSettings>({ engine: 'comfy', python: '/saved-python', worker: '/saved-worker', modelsRoot: '/saved-models', lorasRoot: '/saved-loras' })
  const scope = effectScope(); scopes.push(scope)
  const state = scope.run(() => useInferenceSetup(configured, ref(false), api))!
  state.basePython.value = input.basePython; state.wheelhouse.value = input.wheelhouse; state.workspacePath.value = input.workspacePath
  return { api, scope, state, configured }
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.mocked(localSetupApi.getOperation).mockReset().mockResolvedValue({ ok: true, operation: null })
  vi.mocked(localSetupApi.cancelEnvironment).mockReset().mockResolvedValue({ ok: true })
})
afterEach(async () => { scopes.splice(0).forEach(scope => scope.stop()); await vi.runAllTimersAsync(); vi.useRealTimers() })
describe('offline inference setup workflow', () => {
  it('requires reviewed local sources, prevents duplicate preparation and waits for completion', async () => {
    const post = deferred<InferenceSetupResult>()
    const { api, state } = setup({ prepareRuntime: vi.fn(() => post.promise) })
    await state.prepare(); expect(api.prepareRuntime).not.toHaveBeenCalled()
    state.runtimeReviewed.value = true
    const pending = state.prepare(); await flushPromises(); await state.prepare()
    expect(api.prepareRuntime).toHaveBeenCalledExactlyOnceWith(input)
    vi.mocked(localSetupApi.getOperation).mockResolvedValue({ ok: true, operation: operation() })
    post.resolve({ ok: true, operation: operation(), preparedPaths: paths }); await flushPromises()
    expect(state.preparedPaths.value).toBeNull(); expect(state.busy.value).toBe(true)
    vi.mocked(localSetupApi.getOperation).mockResolvedValue({ ok: true, operation: operation('completed') })
    await vi.advanceTimersByTimeAsync(500); await pending
    expect(state.preparedPaths.value).toEqual(paths); expect(state.busy.value).toBe(false)
    state.wheelhouse.value = '/other-wheels'
    expect(state.runtimeReviewed.value).toBe(false); expect(state.preparedPaths.value).toBeNull()
  })
  it('discards late inspection results and invalidates a plan when saved paths change', async () => {
    const late = deferred<InferenceModelInspection>()
    const { api, state, configured } = setup({ inspectModel: vi.fn().mockReturnValueOnce(late.promise).mockResolvedValue(plan) })
    state.sourceDir.value = '/source'
    const pending = state.inspect()
    state.sourceDir.value = '/new-source'; late.resolve(plan); await pending
    expect(state.inspection.value).toBeNull()
    await state.inspect(); state.importReviewed.value = true
    configured.value.modelsRoot = '/other-saved-root'
    expect(state.inspection.value).toBeNull(); expect(state.importReviewed.value).toBe(false)
    await state.importModel(); expect(api.importModel).not.toHaveBeenCalled()
  })
  it('copies only after inspection and consent, sends the saved root and reports layout-only completion', async () => {
    const imported = operation('completed', { kind: 'import-inference-model', preparedPaths: undefined, modelId: 'anima-miaomiao-v1.6', sourceDir: '/source', modelsRoot: '/saved-models' })
    const { api, state, configured } = setup({ importModel: vi.fn().mockResolvedValue({ ok: true, operation: imported }) })
    state.sourceDir.value = '/source'; await state.importModel(); await state.inspect(); await state.importModel()
    expect(api.importModel).not.toHaveBeenCalled()
    state.importReviewed.value = true
    vi.mocked(localSetupApi.getOperation).mockResolvedValueOnce({ ok: true, operation: null }).mockResolvedValue({ ok: true, operation: imported })
    await state.importModel()
    expect(api.importModel).toHaveBeenCalledExactlyOnceWith({ modelId: 'anima-miaomiao-v1.6', sourceDir: '/source', modelsRoot: '/saved-models', reviewed: true })
    expect(configured.value.engine).toBe('comfy'); expect(state.message.value).toContain('真实出图尚未验证')
    expect(state.inspection.value).toBeNull()
  })
  it.each([true, false])('reconciles a lost POST only with a fresh matching operation (match=%s)', async matches => {
    const { api, state } = setup({ prepareRuntime: vi.fn().mockRejectedValue(new ApiClientError('timeout', { kind: 'timeout' })) })
    state.runtimeReviewed.value = true
    const old = operation('completed', { id: 'old' })
    const found = matches ? operation('completed') : old
    vi.mocked(localSetupApi.getOperation).mockResolvedValueOnce({ ok: true, operation: old }).mockResolvedValue({ ok: true, operation: found })
    await state.prepare(); await state.prepare()
    expect(api.prepareRuntime).toHaveBeenCalledOnce()
    expect(state.preparedPaths.value).toEqual(matches ? paths : null)
    expect(state.operationUncertain.value).toBe(!matches)
    expect(state.canPrepare.value).toBe(false)
  })
  it('uses the operation ID for cancel and stays busy until the actual terminal status', async () => {
    const { state, api } = setup()
    state.runtimeReviewed.value = true
    vi.mocked(localSetupApi.getOperation).mockResolvedValueOnce({ ok: true, operation: null }).mockResolvedValue({ ok: true, operation: operation() })
    const pending = state.prepare(); await flushPromises()
    await state.cancel(); await state.prepare()
    expect(localSetupApi.cancelEnvironment).toHaveBeenCalledExactlyOnceWith('native-1')
    expect(state.busy.value).toBe(true); expect(state.cancelState.value).toBe('accepted'); expect(api.prepareRuntime).toHaveBeenCalledOnce()
    vi.mocked(localSetupApi.getOperation).mockResolvedValue({ ok: true, operation: operation('failed', { error: '操作已取消' }) })
    await vi.advanceTimersByTimeAsync(500); await pending
    expect(state.busy.value).toBe(false); expect(state.preparedPaths.value).toBeNull(); expect(state.error.value).toBe('操作已取消')
  })
  it('detaches on unmount without cancelling the server operation or applying a late completion', async () => {
    const { state, scope } = setup()
    state.runtimeReviewed.value = true
    vi.mocked(localSetupApi.getOperation).mockResolvedValueOnce({ ok: true, operation: null }).mockResolvedValue({ ok: true, operation: operation() })
    const pending = state.prepare(); await flushPromises(); scope.stop()
    vi.mocked(localSetupApi.getOperation).mockResolvedValue({ ok: true, operation: operation('completed') })
    await vi.advanceTimersByTimeAsync(500); await pending
    expect(localSetupApi.cancelEnvironment).not.toHaveBeenCalled(); expect(state.preparedPaths.value).toBeNull()
  })
})
