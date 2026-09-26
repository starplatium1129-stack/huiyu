import { beforeEach, expect, it, vi } from 'vitest'
const api = vi.hoisted(() => ({ submit: vi.fn(), wait: vi.fn(), cancel: vi.fn(), key: vi.fn(() => 'stable-click') }))
vi.mock('@/api/runtimeTaskAuthority', () => ({ hasRuntimeTasks: () => true, runtimeRequestKey: api.key }))
vi.mock('@/api/runtimeTasks', () => ({ submitRuntimeTask: api.submit, waitForRuntimeTask: api.wait, cancelRuntimeTaskKey: api.cancel,
  fetchRuntimeResult: vi.fn(), runtimeResultPath: vi.fn(), taskMessage: () => '生成中' }))
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks()
  api.submit.mockResolvedValue({ taskId: 'accepted-task' })
  api.wait.mockImplementation((_id: string, signal: AbortSignal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('unsubscribe', 'AbortError')), { once: true })))
  api.cancel.mockResolvedValue(null)
})
it('leaving an accepted desktop generation only releases its observation', async () => {
  const { useSDGenerate } = await import('./useSDGenerate')
  const sd = useSDGenerate(), work = sd.generate({ prompt: 'fixture', seed: 0 })
  await vi.waitFor(() => expect(api.wait).toHaveBeenCalledOnce())
  sd.dispose(); await work
  expect(api.submit).toHaveBeenCalledOnce(); expect(api.cancel).not.toHaveBeenCalled()
})
it('explicit cancellation uses the original request key', async () => {
  const { useSDGenerate } = await import('./useSDGenerate')
  const sd = useSDGenerate(), work = sd.generate({ prompt: 'fixture', seed: 0 })
  await vi.waitFor(() => expect(api.wait).toHaveBeenCalledOnce())
  sd.cancel(); await work
  await vi.waitFor(() => expect(api.cancel).toHaveBeenCalledWith('stable-click'))
  sd.dispose()
})
