import { effectScope } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useShotFirstFrames } from './useShotFirstFrames'
import type { ShotDraft } from './shotListTypes'
const mocks = vi.hoisted(() => ({ request: vi.fn(), upload: vi.fn(), durable: false, submit: vi.fn(), wait: vi.fn(), cancel: vi.fn() }))
vi.mock('@/api/client', () => ({ apiClient: { request: mocks.request } }))
vi.mock('@/api/videoApi', () => ({ uploadVideoImage: mocks.upload }))
vi.mock('@/storage/artworkRepository', () => ({ artworkRepository: { putImage: vi.fn() } }))
vi.mock('@/api/runtimeTasks', () => ({ hasRuntimeTasks: () => mocks.durable, runtimeRequestKey: () => 'request-first-frame',
  submitRuntimeTask: mocks.submit, waitForRuntimeTask: mocks.wait, cancelRuntimeTaskKey: mocks.cancel,
  fetchRuntimeResult: vi.fn(), runtimeResultPath: vi.fn() }))
vi.mock('@/composables/useTaskCenter', () => ({ useTrackedTask: vi.fn() }))
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); mocks.durable = false })
const shot = () => ({ firstFramePrompt: 'A quiet room', imageName: '', imageUrl: '' } as ShotDraft)
describe('first-frame batch cancellation', () => {
  it('detaches desktop observation on unload while keeping the accepted task and exact input', async () => {
    mocks.durable = true
    mocks.submit.mockResolvedValue({ taskId: 'accepted', requestKey: 'request-first-frame' })
    mocks.wait.mockImplementation((_id, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))))
    const scope = effectScope(), tools = scope.run(() => useShotFirstFrames({ onError: vi.fn() }))!
    const pending = tools.generateFirstFrames([shot(), shot()], 'portrait')
    await vi.waitFor(() => expect(mocks.wait).toHaveBeenCalledTimes(1))
    scope.stop(); await pending
    expect(mocks.submit).toHaveBeenCalledWith('creative', { prompt: 'A quiet room', modelId: 'krea2-turbo-fp8', width: 1024, height: 1536 }, 'request-first-frame', expect.any(Object))
    expect(mocks.submit).toHaveBeenCalledTimes(1)
    expect(mocks.cancel).not.toHaveBeenCalled()
    expect(mocks.request).not.toHaveBeenCalled()
  })
  it('records explicit desktop cancellation by the original key before acceptance returns', async () => {
    mocks.durable = true
    let finish!: (value: unknown) => void
    mocks.submit.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const scope = effectScope(), tools = scope.run(() => useShotFirstFrames({ onError: vi.fn() }))!
    const pending = tools.generateFirstFrames([shot()], 'square')
    await vi.waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1))
    await tools.cancelFirstFrames()
    finish({ taskId: 'late', requestKey: 'request-first-frame' }); await pending
    expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith('request-first-frame')
    expect(mocks.wait).not.toHaveBeenCalled()
    scope.stop()
  })
  it('cancels the owned backend job and never starts the next shot', async () => {
    mocks.request.mockImplementation(async (_path, options) => {
      if (options.method === 'POST') return { ok: true, job: { id: 'owned', status: 'running' } }
      if (options.method === 'DELETE') return { ok: true }
      return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason)))
    })
    const scope = effectScope()
    const tools = scope.run(() => useShotFirstFrames({ onError: vi.fn() }))!
    const pending = tools.generateFirstFrames([shot(), shot()], 'landscape')
    await vi.waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(2))
    await tools.cancelFirstFrames()
    await pending
    expect(mocks.request.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(1)
    expect(mocks.request).toHaveBeenCalledWith('/api/creative/jobs/owned', expect.objectContaining({ method: 'DELETE' }))
    expect(tools.firstFrameBusy.value).toBe(false)
    scope.stop()
  })
  it('rejects failed result downloads instead of uploading an error page as a frame', async () => {
    mocks.request.mockResolvedValue({ ok: true, job: { id: 'one', status: 'succeeded', resultUrl: '/missing.png' } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('missing', { status: 404 })))
    const scope = effectScope(), onError = vi.fn()
    const tools = scope.run(() => useShotFirstFrames({ onError }))!
    await tools.generateFirstFrames([shot()], 'landscape')
    expect(mocks.upload).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('生成失败'))
    scope.stop()
  })
})
