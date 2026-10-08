import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RuntimeSdAttempt } from './legacySdTaskSession'
import type { TaskRecord } from '../../../types/tasks'
const api = vi.hoisted(() => ({ submit: vi.fn(), get: vi.fn(), wait: vi.fn(), cancel: vi.fn(), result: vi.fn() }))
vi.mock('@/api/runtimeTaskAuthority', () => ({ hasRuntimeTasks: () => true }))
vi.mock('@/api/runtimeTasks', () => ({ submitRuntimeTask: api.submit, getRuntimeTaskByKey: api.get, waitForRuntimeTask: api.wait,
  cancelRuntimeTaskKey: api.cancel, fetchRuntimeResult: api.result, runtimeResultPath: () => '/api/tasks/v1/accepted-task/results/0', taskMessage: () => '核对中' }))
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks()
  api.get.mockResolvedValue({ taskId: 'accepted-task' })
  api.wait.mockImplementation((_id: string, signal: AbortSignal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('unsubscribe', 'AbortError')), { once: true })))
  api.cancel.mockResolvedValue(null)
  api.result.mockResolvedValue(new Blob(['pixels'], { type: 'image/png' }))
  vi.stubGlobal('URL', class extends URL { static createObjectURL = vi.fn(() => 'blob:runtime-result'); static revokeObjectURL = vi.fn() })
})
afterEach(() => vi.unstubAllGlobals())

it('leaving a saved desktop task only releases observation and keeps the original key', async () => {
  const { useLegacySdTasks } = await import('./useLegacySdTasks')
  const sd = useLegacySdTasks(), work = sd.observe({ prompt: 'fixture' }, { requestKey: 'saved-key' })
  await vi.waitFor(() => expect(api.wait).toHaveBeenCalledOnce())
  expect(api.get).toHaveBeenCalledWith('saved-key', expect.any(AbortSignal))
  sd.dispose(); await work
  expect(sd.taskState.value).toBe('unknown'); expect(api.submit).not.toHaveBeenCalled(); expect(api.cancel).not.toHaveBeenCalled()
})
it('explicit cancellation uses the saved key, including before its cold observation starts', async () => {
  const { useLegacySdTasks } = await import('./useLegacySdTasks')
  const attempt: RuntimeSdAttempt = { key: 'saved-key', cancel: vi.fn().mockResolvedValue(undefined) }
  const sd = useLegacySdTasks(), work = sd.observe({ prompt: 'fixture' }, { attempt })
  sd.cancel(); await work
  expect(attempt.cancel).toHaveBeenCalledOnce()
  expect(api.submit).not.toHaveBeenCalled(); expect(api.cancel).not.toHaveBeenCalled()
})
it('batch acceptance publication preserves its identity and external abort never cancels the task', async () => {
  const { useLegacySdTasks } = await import('./useLegacySdTasks')
  const controller = new AbortController(), accepted = vi.fn(), sd = useLegacySdTasks()
  const work = sd.observe({ prompt: 'fixture' }, { requestKey: 'batch-key', onAccepted: accepted, signal: controller.signal })
  await vi.waitFor(() => expect(api.wait).toHaveBeenCalledOnce())
  expect(api.get).toHaveBeenCalledWith('batch-key', expect.any(AbortSignal))
  expect(accepted).toHaveBeenCalledWith({ taskId: 'accepted-task' })
  controller.abort(); await work
  expect(api.submit).not.toHaveBeenCalled(); expect(api.cancel).not.toHaveBeenCalled(); sd.dispose()
})
it('unknown acceptance never creates a task or replaces the stored identity', async () => {
  const { useLegacySdTasks } = await import('./useLegacySdTasks')
  api.get.mockResolvedValueOnce(null)
  const attempt: RuntimeSdAttempt = { key: 'unknown-key', cancel: vi.fn() }, sd = useLegacySdTasks()
  expect(await sd.observe({ prompt: 'fixture' }, { attempt })).toBeNull()
  expect(sd.taskState.value).toBe('unknown'); expect(attempt.key).toBe('unknown-key')
  expect(api.submit).not.toHaveBeenCalled(); expect(attempt.cancel).not.toHaveBeenCalled(); sd.dispose()
})
it('projects the accepted recipe and ownership instead of the current page parameters', async () => {
  const { useLegacySdTasks } = await import('./useLegacySdTasks')
  const task = { taskId: 'accepted-task', kind: 'generation', provider: 'webui', status: 'succeeded', recoveryState: 'normal',
    input: { prompt: 'Original accepted prompt', negative: 'Original negative', seed: 41, cfg: 7 },
    metadata: { seed: 0, loras: [{ id: 'L_NENE_V18_WD14', strength: 0 }], context: { char: 'nene', story: 'Original story' } },
  } as unknown as TaskRecord
  api.wait.mockResolvedValueOnce(task)
  const sd = useLegacySdTasks(), attempt: RuntimeSdAttempt = { key: 'saved-key', task, cancel: vi.fn() }
  await sd.observe({ prompt: 'Later page projection', runtimeContext: { story: 'Later story' } }, { attempt })
  expect(api.get).not.toHaveBeenCalled(); expect(api.submit).not.toHaveBeenCalled()
  expect(sd.resultPrompt.value).toBe('Original accepted prompt'); expect(sd.resultSeed.value).toBe(0)
  expect(sd.lastLoras.value).toEqual([{ id: 'L_NENE_V18_WD14', strength: 0 }])
  expect(sd.resultContext.value).toMatchObject({ char: 'nene', story: 'Original story', history: { cfg: 7, negative: 'Original negative', seed: 0 } })
  sd.dispose()
})
it.each(['failed', 'cancelled'] as const)('keeps observed %s separate from an unknown read', async status => {
  const { useLegacySdTasks } = await import('./useLegacySdTasks')
  const { AcceptedTaskTerminalError } = await import('@/api/acceptedTaskOutcome')
  api.wait.mockRejectedValueOnce(new AcceptedTaskTerminalError('accepted-task', status, 'Observed terminal'))
  const sd = useLegacySdTasks()
  await sd.observe({ prompt: 'fixture' }, { requestKey: 'saved-key' })
  expect(sd.taskState.value).toBe(status); expect(api.submit).not.toHaveBeenCalled(); sd.dispose()
})
it('a late cancellation failure cannot overwrite a later observed successful result', async () => {
  const { useLegacySdTasks } = await import('./useLegacySdTasks')
  let reject!: (error: unknown) => void
  api.cancel.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
  const sd = useLegacySdTasks(), work = sd.observe({ prompt: 'First' }, { requestKey: 'first-key' })
  await vi.waitFor(() => expect(api.wait).toHaveBeenCalledOnce())
  sd.cancel(); await work
  await vi.waitFor(() => expect(api.cancel).toHaveBeenCalledWith('first-key'))
  api.wait.mockResolvedValueOnce({ taskId: 'other-task', kind: 'generation', input: { prompt: 'Second' }, metadata: {} })
  await sd.observe({ prompt: 'Second' }, { requestKey: 'other-key' })
  reject(new Error('Old receipt lost')); await Promise.resolve(); await Promise.resolve()
  expect(sd.taskState.value).toBe('succeeded'); expect(sd.errorMsg.value).toBe(''); sd.dispose()
})
it('a busy observer leaves another saved attempt untouched', async () => {
  const { useLegacySdTasks } = await import('./useLegacySdTasks')
  const sd = useLegacySdTasks(), work = sd.observe({ prompt: 'First' }, { requestKey: 'first-key' })
  await vi.waitFor(() => expect(api.wait).toHaveBeenCalledOnce())
  const attempt: RuntimeSdAttempt = { key: 'waiting-key', cancel: vi.fn() }
  expect(await sd.observe({ prompt: 'Queued' }, { attempt })).toBeNull()
  expect(attempt.key).toBe('waiting-key'); expect(api.get).toHaveBeenCalledOnce()
  expect(attempt.cancel).not.toHaveBeenCalled(); expect(api.submit).not.toHaveBeenCalled()
  sd.dispose(); await work
})
