import { beforeEach, expect, it, vi } from 'vitest'
import { submitRuntimeTask } from './runtimeTasks'
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
