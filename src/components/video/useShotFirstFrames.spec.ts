import { effectScope, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useShotFirstFrames } from './useShotFirstFrames'
import type { ShotDraft } from './shotListTypes'
const mocks = vi.hoisted(() => ({ request: vi.fn(), upload: vi.fn(), put: vi.fn(), stage: vi.fn(), durable: false, submit: vi.fn(), wait: vi.fn(), cancel: vi.fn() }))
vi.mock('@/api/client', () => ({ apiClient: { request: mocks.request } }))
vi.mock('@/api/videoApi', () => ({ uploadVideoImage: mocks.upload }))
vi.mock('@/storage/artworkRepository', () => ({ artworkRepository: { putImage: mocks.put } }))
vi.mock('@/storage/artworkSession', () => ({ withArtworkStaging: mocks.stage }))
vi.mock('@/stores/runtimeTaskState', async importOriginal => ({ ...await importOriginal<object>(), runtimeRequestKey: () => 'request-first-frame' }))
vi.mock('@/api/runtimeTasks', () => ({ hasRuntimeTasks: () => mocks.durable,
  submitRuntimeTask: mocks.submit, waitForRuntimeTask: mocks.wait, cancelRuntimeTaskKey: mocks.cancel,
  fetchRuntimeResult: vi.fn(), runtimeResultPath: vi.fn() }))
vi.mock('@/composables/useTaskCenter', () => ({ useTrackedTask: vi.fn() }))
beforeEach(() => { mocks.stage.mockImplementation((work: () => Promise<unknown>) => work()) })
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); vi.unstubAllGlobals(); mocks.durable = false })
const shot = () => ({ firstFramePrompt: 'A quiet room', imageName: '', imageUrl: '' } as ShotDraft)
function setup(items: ShotDraft[], onError = vi.fn()) {
  const shots = ref(items), frameRequests = new Map<ShotDraft, AbortController>(), scope = effectScope()
  const tools = scope.run(() => useShotFirstFrames({ shots, frameRequests, onError }))!
  return { shots, frameRequests, scope, tools, onError }
}
function prepareSuccessfulFrames() {
  mocks.request.mockResolvedValue({ ok: true, job: { id: 'one', status: 'succeeded', resultUrl: '/frame.png' } })
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(new Blob(['frame']))))
  mocks.upload.mockResolvedValue({ name: 'generated.png' })
  mocks.put.mockResolvedValue('generated-id')
  const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:generated')
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  return { create, revoke }
}
describe('first-frame batch cancellation', () => {
  it('does not start generation when a staging lock is released after disposal', async () => {
    let release!: () => void
    mocks.stage.mockImplementationOnce((work: () => Promise<unknown>) => new Promise(resolve => { release = () => resolve(work()) }))
    const { scope, tools, shots, frameRequests } = setup([shot()])
    const pending = tools.generateFirstFrames(shots.value, 'landscape')
    expect(tools.firstFrameBusy.value).toBe(true)
    scope.stop()
    release()
    await pending
    expect(mocks.request).not.toHaveBeenCalled()
    expect(mocks.submit).not.toHaveBeenCalled()
    expect(frameRequests.size).toBe(0)
    expect(tools.firstFrameBusy.value).toBe(false)
  })
  it('leaves existing frame requests alone while generating other eligible shots', async () => {
    prepareSuccessfulFrames()
    const { scope, tools, shots, frameRequests } = setup([shot(), shot()])
    const existing = new AbortController()
    frameRequests.set(shots.value[0], existing)
    await tools.generateFirstFrames(shots.value, 'landscape')
    expect(existing.signal.aborted).toBe(false)
    expect(frameRequests.get(shots.value[0])).toBe(existing)
    expect(shots.value[0].imageName).toBe('')
    expect(shots.value[1].imageName).toBe('generated.png')
    expect(mocks.request.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(1)
    scope.stop()
  })
  it('skips a queued frame cleared during an earlier upload and still processes the next shot', async () => {
    const { create } = prepareSuccessfulFrames()
    let finish!: (value: unknown) => void
    mocks.upload.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    const { scope, tools, shots, frameRequests } = setup([shot(), shot(), shot()])
    const pending = tools.generateFirstFrames(shots.value, 'landscape')
    await vi.waitFor(() => expect(mocks.upload).toHaveBeenCalledTimes(1))
    frameRequests.get(shots.value[1])!.abort()
    finish({ name: 'first.png' })
    await pending
    expect(shots.value.map(value => value.imageName)).toEqual(['first.png', '', 'generated.png'])
    expect(mocks.request.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(2)
    expect(create).toHaveBeenCalledTimes(2)
    scope.stop()
  })
  it.each(['replacement', 'removal'])('does not publish an active result after %s and continues valid later shots', async change => {
    const { create, revoke } = prepareSuccessfulFrames()
    let finish!: (value: string) => void
    mocks.put.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    const { scope, tools, shots, frameRequests } = setup([shot(), shot()])
    const first = shots.value[0], next = shots.value[1], newer = new AbortController()
    const pending = tools.generateFirstFrames(shots.value, 'landscape')
    await vi.waitFor(() => expect(mocks.put).toHaveBeenCalledTimes(1))
    if (change === 'replacement') {
      frameRequests.get(first)!.abort()
      frameRequests.set(first, newer)
      Object.assign(first, { imageId: 'manual-id', imageName: 'manual.png', imageUrl: 'blob:manual' })
    } else shots.value.splice(0, 1)
    finish('old-generated-id')
    await pending
    expect(first.imageName).toBe(change === 'replacement' ? 'manual.png' : '')
    expect(next.imageName).toBe('generated.png')
    expect(create).toHaveBeenCalledTimes(1)
    expect(revoke).not.toHaveBeenCalled()
    if (change === 'replacement') expect(frameRequests.get(first)).toBe(newer)
    scope.stop()
  })

  it('detaches desktop observation on unload while keeping the accepted task and exact input', async () => {
    mocks.durable = true
    mocks.submit.mockResolvedValue({ taskId: 'accepted', requestKey: 'request-first-frame' })
    mocks.wait.mockImplementation((_id, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))))
    const { scope, tools, shots } = setup([shot(), shot()])
    const pending = tools.generateFirstFrames(shots.value, 'portrait')
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
    const { scope, tools, shots } = setup([shot()])
    const pending = tools.generateFirstFrames(shots.value, 'square')
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
    const { scope, tools, shots } = setup([shot(), shot()])
    const pending = tools.generateFirstFrames(shots.value, 'landscape')
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
    const { scope, tools, shots, onError } = setup([shot()])
    await tools.generateFirstFrames(shots.value, 'landscape')
    expect(mocks.upload).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('生成失败'))
    scope.stop()
  })
})
