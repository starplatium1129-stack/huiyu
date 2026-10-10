import { describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'
import { useInferenceSettings } from './useInferenceSettings'
import type { InferenceSettingsApi, InferenceStatusResponse, InferenceSettingsResponse, InferenceProbeResponse } from '@/api/inferenceSettingsApi'
vi.mock('@/utils/runtimeEnvironment', () => ({ isLocalStudioHost: () => true }))
function fixture(): InferenceStatusResponse {
  const settings = { engine: 'comfy' as const, modelsRoot: '/models', lorasRoot: '/loras', python: '/python', worker: '/worker' }
  return { ok: true, active: { ...settings }, configured: { ...settings }, restartRequired: false, environmentOverrides: [],
    diagnostics: { basis: 'configured', configuration: 'valid', files: { modelsRoot: true, lorasRoot: false, python: true, worker: true }, dependencies: 'unchecked', runtime: 'unverified', message: '' } }
}
function setup(overrides: Partial<InferenceSettingsApi> = {}) {
  const api: InferenceSettingsApi = { getStatus: vi.fn().mockResolvedValue(fixture()), save: vi.fn(), diagnose: vi.fn(), ...overrides }
  const scope = effectScope()
  const state = scope.run(() => useInferenceSettings(api))!
  return { api, scope, state }
}
describe('inference settings workflow', () => {
  it('keeps edits across refresh and failed saves, and prevents duplicate submissions', async () => {
    let reject!: (cause: Error) => void
    const { api, state, scope } = setup({ save: vi.fn(() => new Promise<InferenceSettingsResponse>((_, fail) => { reject = fail })) })
    await state.refresh()
    state.draft.engine = 'native'
    await state.refresh()
    expect(state.draft.engine).toBe('native')
    const pending = state.save()
    await state.save()
    expect(api.save).toHaveBeenCalledOnce()
    reject(new Error('Path unavailable'))
    await pending
    expect(state.draft.engine).toBe('native')
    expect(state.error.value).toBe('Path unavailable')
    expect(state.dirty.value).toBe(true)
    scope.stop()
  })
  it('shows saved versus active settings and does not overwrite edits made during save', async () => {
    let resolve!: (value: InferenceSettingsResponse) => void
    const { state, scope } = setup({ save: vi.fn(() => new Promise<InferenceSettingsResponse>(done => { resolve = done })) })
    await state.refresh()
    state.draft.engine = 'native'
    const pending = state.save()
    state.draft.modelsRoot = '/newer-edit'
    const result = fixture(); result.configured.engine = 'native'; result.restartRequired = true
    resolve(result)
    await pending
    expect(state.snapshot.value?.active.engine).toBe('comfy')
    expect(state.notice.value).toContain('重启')
    expect(state.draft.modelsRoot).toBe('/newer-edit')
    expect(state.diagnostics.value).toBeNull()
    scope.stop()
  })
  it('aborts on disposal and ignores late responses', async () => {
    let resolve!: (value: InferenceStatusResponse) => void
    const { api, state, scope } = setup({ getStatus: vi.fn(() => new Promise<InferenceStatusResponse>(done => { resolve = done })) })
    const pending = state.refresh()
    const signal = vi.mocked(api.getStatus).mock.calls[0][0]!
    scope.stop()
    expect(signal.aborted).toBe(true)
    resolve(fixture()); await pending
    expect(state.snapshot.value).toBeNull()
  })
  it('runs dependency diagnostics only explicitly and prevents duplicate checks', async () => {
    let reject!: (cause: Error) => void
    const { api, state, scope } = setup({ diagnose: vi.fn(() => new Promise<InferenceProbeResponse>((_, fail) => { reject = fail })) })
    await state.refresh()
    expect(api.diagnose).not.toHaveBeenCalled()
    const pending = state.diagnose(); await state.diagnose()
    expect(api.diagnose).toHaveBeenCalledOnce()
    reject(new Error('Missing torch')); await pending
    expect(state.probeError.value).toBe('Missing torch')
    expect(state.probe.value).toBeNull()
    scope.stop()
  })
})
