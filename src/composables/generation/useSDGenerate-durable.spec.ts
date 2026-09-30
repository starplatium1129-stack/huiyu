import { beforeEach, expect, it, vi } from 'vitest'
const api = vi.hoisted(() => ({ submit: vi.fn(), wait: vi.fn(), cancel: vi.fn(), key: vi.fn(() => 'stable-click') }))
vi.mock('@/stores/runtimeTaskState', async importOriginal => ({ ...await importOriginal<object>(), runtimeRequestKey: api.key }))
vi.mock('@/api/runtimeTaskAuthority', () => ({ hasRuntimeTasks: () => true }))
vi.mock('@/api/runtimeTasks', () => ({ submitRuntimeTask: api.submit, waitForRuntimeTask: api.wait, cancelRuntimeTaskKey: api.cancel,
  fetchRuntimeResult: vi.fn(), runtimeResultPath: vi.fn(), taskMessage: () => '生成中' }))
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks()
  api.submit.mockImplementation(async (_kind, _input, _key, _context, observation) => {
    observation?.signal?.throwIfAborted(); observation?.onSubmitting?.()
    return { taskId: 'accepted-task' }
  })
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
it('batch identity and acceptance hook are preserved; its signal stops observation without cancelling runtime ownership', async () => {
  const { useSDGenerate } = await import('./useSDGenerate')
  const controller = new AbortController(), accepted = vi.fn(), submitting = vi.fn()
  const sd = useSDGenerate(), work = sd.generate({ prompt: 'fixture', seed: 0 }, { requestKey: 'batch-job-key', onAccepted: accepted, onSubmitting: submitting, signal: controller.signal })
  await vi.waitFor(() => expect(api.wait).toHaveBeenCalledOnce())
  expect(api.submit.mock.calls[0][2]).toBe('batch-job-key')
  expect(accepted).toHaveBeenCalledWith({ taskId: 'accepted-task' }); expect(api.key).not.toHaveBeenCalled()
  expect(submitting).toHaveBeenCalledOnce()
  controller.abort(); await work
  expect(api.cancel).not.toHaveBeenCalled(); sd.dispose()
})
it('closing during the cold durable execution import never reaches POST or its submission hook', async () => {
  let release!: () => void, entered = false
  const gate = new Promise<void>(resolve => { release = resolve })
  vi.doMock('./runtimeImageSession', async () => { entered = true; await gate; return vi.importActual<object>('./runtimeImageSession') })
  const { useSDGenerate } = await import('./useSDGenerate')
  const signal = new AbortController(), submitting = vi.fn()
  const sd = useSDGenerate(), work = sd.generate({ prompt: 'fixture', seed: 0 }, { requestKey: 'batch-cold-key', signal: signal.signal, onSubmitting: submitting })
  try {
    await vi.waitFor(() => expect(entered).toBe(true))
    signal.abort(); release(); await work
    expect(api.submit).not.toHaveBeenCalled(); expect(submitting).not.toHaveBeenCalled()
  } finally { signal.abort(); release(); sd.dispose(); vi.doUnmock('./runtimeImageSession') }
})
