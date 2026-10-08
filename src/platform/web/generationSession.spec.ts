import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { observeWebGeneration } from './generationSession'
import { ApiClientError } from '@/api/client'
import { AcceptedTaskTerminalError } from '@/api/acceptedTaskOutcome'
const api = vi.hoisted(() => ({ create: vi.fn(), get: vi.fn(), remove: vi.fn(), fetch: vi.fn() }))
vi.mock('@/api/generationApi', () => ({ generationApi: { createJob: api.create, getJob: api.get, deleteJob: api.remove } }))
vi.mock('@/platform/runtimeUrl', () => ({ runtimeFetch: api.fetch }))
const completed = (id = 'known') => ({ job: { id, provider: 'comfy', status: 'succeeded', resultUrl: '/result.png', seed: 0 } })
beforeEach(() => {
  vi.resetAllMocks(); api.create.mockResolvedValue(completed()); api.get.mockResolvedValue(completed()); api.remove.mockResolvedValue({})
  api.fetch.mockResolvedValue(new Response(new Blob(['image'], { type: 'image/png' }), { headers: { 'Content-Type': 'image/png' } }))
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
const options = (signal = new AbortController().signal) => ({ signal, accepted: vi.fn(), progress: vi.fn(), onSubmitting: vi.fn(), preserveAccepted: true })
it('an already-aborted cold observation never submits or reports submission', async () => {
  const controller = new AbortController(); controller.abort()
  const observe = options(controller.signal)
  await expect(observeWebGeneration('known', observe)).rejects.toMatchObject({ name: 'AbortError' })
  expect(api.create).not.toHaveBeenCalled(); expect(observe.onSubmitting).not.toHaveBeenCalled()
})
it('publishes the original accepted identity without invoking admission', async () => {
  const observe = options()
  api.get.mockImplementationOnce(async () => { expect(observe.onSubmitting).not.toHaveBeenCalled(); return completed() })
  const result = await observeWebGeneration('known', observe)
  expect(result.seed).toBe(0); expect(observe.accepted).toHaveBeenCalledWith('known', 'comfy')
})
it('a persisted legacy SD identity resumes by GET and never invokes admission', async () => {
  const observe = { ...options() }
  await observeWebGeneration('known', observe)
  expect(api.get).toHaveBeenCalledWith('known', expect.objectContaining({ signal: observe.signal }))
  expect(api.create).not.toHaveBeenCalled(); expect(observe.onSubmitting).not.toHaveBeenCalled()
})
it.each(['failed', 'cancelled'] as const)('a known legacy %s response returns a bound terminal observation', async status => {
  api.get.mockResolvedValue({ job: { ...completed().job, status, error: 'observed failure' } })
  await expect(observeWebGeneration('known', { ...options() }))
    .rejects.toMatchObject({ taskId: 'known', status })
  expect(api.create).not.toHaveBeenCalled()
})
it('an unrelated response ID cannot confirm terminal state for the original task', async () => {
  api.get.mockResolvedValue({ job: { ...completed('another').job, status: 'failed' } })
  const error = await observeWebGeneration('known', { ...options() }).catch(error => error)
  expect(error).not.toBeInstanceOf(AcceptedTaskTerminalError); expect(api.create).not.toHaveBeenCalled()
})
it('closing a batch observation after acceptance leaves the accepted job owned by its plan', async () => {
  const controller = new AbortController()
  const observe = { ...options(controller.signal), accepted: () => { controller.abort() } }
  await expect(observeWebGeneration('known', observe)).rejects.toMatchObject({ name: 'AbortError' })
  expect(api.create).not.toHaveBeenCalled(); expect(api.remove).not.toHaveBeenCalled()
})


it.each(['network', 'timeout', 'server'] as const)('keeps observing the accepted ID after a transient %s polling failure', async kind => {
  vi.useFakeTimers()
  api.get.mockResolvedValueOnce({ job: { ...completed().job, status: 'running', resultUrl: null } })
  api.get.mockRejectedValueOnce(new ApiClientError('temporary', kind === 'server' ? { kind: 'http', status: 503 } : { kind }))
    .mockResolvedValueOnce(completed())
  const observe = options()
  const work = observeWebGeneration('known', observe)
  await vi.advanceTimersByTimeAsync(700)
  expect(api.get).toHaveBeenCalledTimes(2)
  expect(observe.progress).toHaveBeenCalledWith(expect.objectContaining({ status: 'running', progress: null, text: expect.stringContaining('原任务') }))
  expect(api.create).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(700)
  expect((await work).seed).toBe(0)
  expect(api.get.mock.calls.map(([id]) => id)).toEqual(['known', 'known', 'known'])
  expect(api.create).not.toHaveBeenCalled()
  expect(api.remove).not.toHaveBeenCalled()
})

it('stops reconnect polling after cancellation without resubmitting or deleting a batch-owned job', async () => {
  vi.useFakeTimers()
  api.get.mockResolvedValueOnce({ job: { ...completed().job, status: 'running', resultUrl: null } })
  api.get.mockRejectedValueOnce(new ApiClientError('temporary', { kind: 'network' }))
  const controller = new AbortController()
  const work = observeWebGeneration('known', options(controller.signal))
  const rejected = expect(work).rejects.toMatchObject({ name: 'AbortError' })
  await vi.advanceTimersByTimeAsync(700)
  controller.abort()
  await vi.advanceTimersByTimeAsync(700)
  await rejected
  expect(api.get).toHaveBeenCalledTimes(2)
  expect(api.create).not.toHaveBeenCalled()
  expect(api.remove).not.toHaveBeenCalled()
})

it('does not retry permanent polling errors as transport recovery', async () => {
  vi.useFakeTimers()
  api.get.mockResolvedValueOnce({ job: { ...completed().job, status: 'running', resultUrl: null } })
  const error = new ApiClientError('forbidden', { kind: 'http', status: 403 })
  api.get.mockRejectedValueOnce(error)
  const rejected = expect(observeWebGeneration('known', options())).rejects.toBe(error)
  await vi.advanceTimersByTimeAsync(700)
  await rejected
  expect(api.get).toHaveBeenCalledTimes(2)
  expect(api.create).not.toHaveBeenCalled()
})
