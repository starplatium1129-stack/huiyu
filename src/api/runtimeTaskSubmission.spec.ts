import { beforeEach, expect, it, vi } from 'vitest'
import { submitRuntimeTask } from './runtimeTasks'
import { retryRuntimeVideoShot } from './runtimeVideo'
import type { TaskRecord } from '../../types/tasks'
import { resetRuntimeTaskWorkspace } from '@/stores/runtimeTaskState'
const api = vi.hoisted(() => ({ send: vi.fn() }))
vi.mock('./client', async importOriginal => ({ ...await importOriginal<object>(), apiClient: { request: api.send } }))
vi.mock('./runtimeTaskAuthority', () => ({ hasRuntimeTasks: () => true }))
vi.mock('@/platform/desktop/runtime.ts', () => ({ getDesktopRuntime: () => ({ connection: 'ready', bootstrap: { runtime: { workspace: { runtimeEpoch: 'epoch' } } } }),
  desktopRuntimeFetch: vi.fn(), onDesktopRuntime: vi.fn() }))
beforeEach(() => { vi.clearAllMocks(); resetRuntimeTaskWorkspace() })
it('an aborted pre-submission observer never invokes the runtime POST or the submitting hook', async () => {
  const controller = new AbortController(), submitting = vi.fn(); controller.abort()
  await expect(submitRuntimeTask('generation', { prompt: 'fixture' }, 'stable', {}, { signal: controller.signal, onSubmitting: submitting }))
    .rejects.toMatchObject({ name: 'AbortError' })
  expect(api.send).not.toHaveBeenCalled(); expect(submitting).not.toHaveBeenCalled()
})
it('the submission notification precedes POST and carries the observer signal while preserving its stable key', async () => {
  const controller = new AbortController(), submitting = vi.fn()
  api.send.mockImplementation(async (_path, options) => {
    expect(submitting).toHaveBeenCalledOnce()
    expect(options.signal).toBe(controller.signal); expect(options.body.requestKey).toBe('stable')
    return { runtimeEpoch: 'epoch', result: { runtimeEpoch: 'epoch', taskId: 'accepted', requestKey: 'stable', revision: 1, createdAt: 1 } }
  })
  const task = await submitRuntimeTask('generation', { prompt: 'fixture' }, 'stable', {}, { signal: controller.signal, onSubmitting: submitting })
  expect(task.taskId).toBe('accepted'); expect(api.send).toHaveBeenCalledOnce()
})

it('reuses unresolved shot retry keys and generates a new key only after acceptance is confirmed', async () => {
  const source = { taskId: 'source', requestKey: 'source-key', kind: 'batch', runtimeEpoch: 'epoch', revision: 1, createdAt: 1,
    upstreamSettled: true, status: 'failed', recoveryState: 'normal', metadata: {}, resultRefs: [],
    input: { modelId: 'minimax-h3', aspectRatio: 'landscape', quality: 'standard', steps: 4, adultEnabled: false },
    checkpoint: { shots: [0, 1].map(index => ({ status: 'failed', input: { prompt: `neutral shot ${index}`, seed: index, duration: 3, camera: 'still', motion: 'subtle' } })) },
  } as unknown as TaskRecord
  const submissions: Array<{ requestKey: string; context: object; input: Record<string, unknown> }> = []
  let accept = false
  api.send.mockImplementation(async (path, options) => {
    if (path.endsWith('/source')) return { runtimeEpoch: 'epoch', result: source }
    if (path.includes('/by-key/')) return { runtimeEpoch: 'epoch', result: null }
    submissions.push(options.body)
    if (!accept) throw new Error('lost acceptance')
    return { runtimeEpoch: 'epoch', result: { ...source, taskId: `accepted-${submissions.length}`, requestKey: options.body.requestKey,
      input: options.body.input, metadata: { context: options.body.context }, checkpoint: null, status: 'queued' } }
  })
  await expect(retryRuntimeVideoShot('source', 2)).rejects.toThrow('尚未确认')
  await expect(retryRuntimeVideoShot('source', 2)).rejects.toThrow('尚未确认')
  expect(submissions[1].requestKey).toBe(submissions[0].requestKey)
  expect(submissions[1].input).toEqual(submissions[0].input)
  accept = true
  const confirmed = await retryRuntimeVideoShot('source', 2)
  expect(submissions[2].requestKey).toBe(submissions[0].requestKey)
  expect(confirmed.retrySource).toEqual({ batchId: 'source', stepIndex: 1 })
  expect(submissions[2].context).toEqual({ retriedTaskId: 'source', stepIndex: 1 })
  await retryRuntimeVideoShot('source', 2)
  expect(submissions[3].requestKey).not.toBe(submissions[0].requestKey)
})
