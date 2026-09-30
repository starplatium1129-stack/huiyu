import { beforeEach, expect, it, vi } from 'vitest'
import { runWebGeneration } from './generationSession'
import { AcceptedTaskTerminalError } from '@/api/acceptedTaskOutcome'
const api = vi.hoisted(() => ({ create: vi.fn(), get: vi.fn(), remove: vi.fn(), fetch: vi.fn() }))
vi.mock('@/api/generationApi', () => ({ generationApi: { createJob: api.create, getJob: api.get, deleteJob: api.remove } }))
vi.mock('@/platform/runtimeUrl', () => ({ runtimeFetch: api.fetch }))
const completed = (id = 'known') => ({ job: { id, provider: 'comfy', status: 'succeeded', resultUrl: '/result.png', seed: 0 } })
beforeEach(() => {
  vi.clearAllMocks(); api.create.mockResolvedValue(completed()); api.get.mockResolvedValue(completed())
  api.fetch.mockResolvedValue(new Response(new Blob(['image'], { type: 'image/png' }), { headers: { 'Content-Type': 'image/png' } }))
})
const options = (signal = new AbortController().signal) => ({ signal, accepted: vi.fn(), progress: vi.fn(), onSubmitting: vi.fn(), preserveAccepted: true })
it('an already-aborted cold observation never submits or reports submission', async () => {
  const controller = new AbortController(); controller.abort()
  const observe = options(controller.signal)
  await expect(runWebGeneration({ prompt: 'fixture' }, observe)).rejects.toMatchObject({ name: 'AbortError' })
  expect(api.create).not.toHaveBeenCalled(); expect(observe.onSubmitting).not.toHaveBeenCalled()
})
it('reports submission immediately before create and waits for accepted identity publication', async () => {
  const observe = options()
  api.create.mockImplementation(async () => { expect(observe.onSubmitting).toHaveBeenCalledOnce(); return completed() })
  const result = await runWebGeneration({ prompt: 'fixture' }, observe)
  expect(result.seed).toBe(0); expect(observe.accepted).toHaveBeenCalledWith('known', 'comfy')
})
it('a persisted legacy SD identity resumes by GET and never invokes admission', async () => {
  const observe = { ...options(), resumeId: 'known' }
  await runWebGeneration({ prompt: 'frozen' }, observe)
  expect(api.get).toHaveBeenCalledWith('known', expect.objectContaining({ signal: observe.signal }))
  expect(api.create).not.toHaveBeenCalled(); expect(observe.onSubmitting).not.toHaveBeenCalled()
})
it.each(['failed', 'cancelled'] as const)('a known legacy %s response returns a bound terminal observation', async status => {
  api.get.mockResolvedValue({ job: { ...completed().job, status, error: 'observed failure' } })
  await expect(runWebGeneration({ prompt: 'frozen' }, { ...options(), resumeId: 'known' }))
    .rejects.toMatchObject({ taskId: 'known', status })
  expect(api.create).not.toHaveBeenCalled()
})
it('an unrelated response ID cannot confirm terminal state for the original task', async () => {
  api.get.mockResolvedValue({ job: { ...completed('another').job, status: 'failed' } })
  const error = await runWebGeneration({ prompt: 'frozen' }, { ...options(), resumeId: 'known' }).catch(error => error)
  expect(error).not.toBeInstanceOf(AcceptedTaskTerminalError); expect(api.create).not.toHaveBeenCalled()
})
it('closing a batch observation after acceptance leaves the accepted job owned by its plan', async () => {
  const controller = new AbortController()
  const observe = { ...options(controller.signal), accepted: () => { controller.abort() } }
  await expect(runWebGeneration({ prompt: 'frozen' }, observe)).rejects.toMatchObject({ name: 'AbortError' })
  expect(api.create).toHaveBeenCalledOnce(); expect(api.remove).not.toHaveBeenCalled()
})
