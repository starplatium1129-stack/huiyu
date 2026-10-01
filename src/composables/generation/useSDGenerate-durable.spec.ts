import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RuntimeSdAttempt } from './runtimeImageSession'
import type { TaskRecord } from '../../../types/tasks'
const api = vi.hoisted(() => ({ submit: vi.fn(), wait: vi.fn(), cancel: vi.fn(), result: vi.fn(), key: vi.fn(() => 'stable-click') }))
vi.mock('@/stores/runtimeTaskState', async importOriginal => ({ ...await importOriginal<object>(), runtimeRequestKey: api.key }))
vi.mock('@/api/runtimeTaskAuthority', () => ({ hasRuntimeTasks: () => true }))
vi.mock('@/api/runtimeTasks', () => ({ submitRuntimeTask: api.submit, waitForRuntimeTask: api.wait, cancelRuntimeTaskKey: api.cancel,
  fetchRuntimeResult: api.result, runtimeResultPath: () => '/api/tasks/v1/accepted-task/results/0', taskMessage: () => '生成中' }))
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks()
  api.submit.mockImplementation(async (_kind, _input, _key, _context, observation) => {
    observation?.signal?.throwIfAborted(); observation?.onSubmitting?.()
    return { taskId: 'accepted-task' }
  })
  api.wait.mockImplementation((_id: string, signal: AbortSignal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('unsubscribe', 'AbortError')), { once: true })))
  api.cancel.mockResolvedValue(null)
  api.result.mockResolvedValue(new Blob(['pixels'], { type: 'image/png' }))
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL = vi.fn(() => 'blob:runtime-result')
    static revokeObjectURL = vi.fn()
  })
})
afterEach(() => vi.unstubAllGlobals())
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

it.each([false, true])('keeps click ownership while the SD projection loads (cancel=%s)', async cancelled => {
  let release!: () => void, entered = false
  const gate = new Promise<void>(resolve => { release = resolve })
  vi.doMock('@/utils/sdRuntimeRequest', async () => {
    entered = true
    await gate
    return vi.importActual<object>('@/utils/sdRuntimeRequest')
  })
  const { useSDGenerate } = await import('./useSDGenerate')
  const signal = new AbortController(), submitting = vi.fn()
  const params = { prompt: 'Original neutral fixture', lora: ['ayachi_nene_v18_wd14:0'], runtimeContext: { sceneId: 'original' } }
  const sd = useSDGenerate(), work = sd.generate(params, { requestKey: 'projection-key', signal: signal.signal, onSubmitting: submitting })
  try {
    await vi.waitFor(() => expect(entered).toBe(true))
    params.prompt = 'Later edited fixture'
    params.lora[0] = 'shiki_natsume_v18_wd14:1'
    params.runtimeContext.sceneId = 'later'
    if (cancelled) signal.abort()
    release()
    if (!cancelled) {
      await vi.waitFor(() => expect(api.wait).toHaveBeenCalledOnce())
      expect(api.submit).toHaveBeenCalledWith('generation', expect.objectContaining({
        prompt: expect.stringContaining('Original neutral fixture'), loras: [{ id: 'L_NENE_V18_WD14', strength: 0 }],
      }), 'projection-key', { sceneId: 'original' }, expect.any(Object))
      expect(submitting).toHaveBeenCalledOnce()
      signal.abort()
    }
    await work
    if (cancelled) {
      expect(api.submit).not.toHaveBeenCalled()
      expect(submitting).not.toHaveBeenCalled()
    }
    expect(api.cancel).not.toHaveBeenCalled()
  } finally { signal.abort(); release(); sd.dispose(); vi.doUnmock('@/utils/sdRuntimeRequest') }
})

it('observes a restored accepted queue attempt without another POST or replacement key', async () => {
  const { useSDGenerate } = await import('./useSDGenerate')
  const attempt = { key: 'saved-key', task: { taskId: 'accepted-task' }, rejected: vi.fn(), cancel: vi.fn() } as unknown as RuntimeSdAttempt
  const sd = useSDGenerate(), work = sd.generate({ prompt: 'neutral fixture' }, { attempt })
  await vi.waitFor(() => expect(api.wait).toHaveBeenCalledOnce())
  expect(api.submit).not.toHaveBeenCalled(); expect(api.key).not.toHaveBeenCalled()
  sd.dispose(); await work
  expect(attempt.cancel).not.toHaveBeenCalled()
})

it('projects the accepted result recipe and ownership when observing a restored queue task', async () => {
  const { useSDGenerate } = await import('./useSDGenerate')
  const task = { taskId: 'accepted-task', kind: 'generation', provider: 'webui', status: 'succeeded', recoveryState: 'normal',
    input: { prompt: 'Original accepted prompt', negative: 'Original negative', seed: 41, cfg: 7 },
    metadata: { seed: 0, loras: [{ id: 'L_NENE_V18_WD14', strength: 0 }], context: { char: 'nene', story: 'Original story' } },
  } as unknown as TaskRecord
  api.wait.mockResolvedValueOnce(task)
  const sd = useSDGenerate()
  const attempt: RuntimeSdAttempt = { key: 'saved-key', task, rejected: vi.fn(), cancel: vi.fn() }
  await sd.generate({ prompt: 'Later page projection', lora: 'shiki_natsume_v18_wd14:0.7', runtimeContext: { story: 'Later story' } }, { attempt })
  expect(api.submit).not.toHaveBeenCalled()
  expect(sd.resultPrompt.value).toBe('Original accepted prompt')
  expect(sd.resultSeed.value).toBe(0)
  expect(sd.lastLoras.value).toEqual([{ id: 'L_NENE_V18_WD14', strength: 0 }])
  expect(sd.resultContext.value).toMatchObject({ char: 'nene', story: 'Original story', history: { cfg: 7, negative: 'Original negative', seed: 0 } })
  sd.dispose()
})

it.each(['failed', 'cancelled'] as const)('keeps an observed %s terminal distinct from unknown runtime observation', async status => {
  const { useSDGenerate } = await import('./useSDGenerate')
  const { AcceptedTaskTerminalError } = await import('@/api/acceptedTaskOutcome')
  api.wait.mockRejectedValueOnce(new AcceptedTaskTerminalError('accepted-task', status, 'Observed terminal'))
  const sd = useSDGenerate()
  await sd.generate({ prompt: 'neutral fixture' })
  expect(sd.taskState.value).toBe(status)
  expect(sd.statusText.value).not.toContain('核对')
  sd.dispose()
})

it('an interrupted observation does not declare an accepted task cancelled', async () => {
  const { useSDGenerate } = await import('./useSDGenerate')
  const sd = useSDGenerate(), controller = new AbortController()
  const work = sd.generate({ prompt: 'neutral fixture' }, { signal: controller.signal })
  await vi.waitFor(() => expect(api.wait).toHaveBeenCalledOnce())
  controller.abort(); await work
  expect(sd.taskState.value).toBe('unknown')
  expect(sd.statusText.value).toContain('仍由运行时管理')
  expect(api.cancel).not.toHaveBeenCalled()
  sd.dispose()
})

it('a late cancellation failure cannot overwrite a newer successful result', async () => {
  const { useSDGenerate } = await import('./useSDGenerate')
  let reject!: (reason: unknown) => void
  api.cancel.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
  const sd = useSDGenerate(), work = sd.generate({ prompt: 'First fixture' })
  await vi.waitFor(() => expect(api.wait).toHaveBeenCalledOnce())
  sd.cancel(); await work
  await vi.waitFor(() => expect(api.cancel).toHaveBeenCalledOnce())
  api.wait.mockResolvedValueOnce({ taskId: 'new-task', kind: 'generation', input: { prompt: 'Second fixture' }, metadata: {} })
  await sd.generate({ prompt: 'Second fixture' })
  reject(new Error('Old receipt lost'))
  await Promise.resolve(); await Promise.resolve()
  expect(sd.taskState.value).toBe('succeeded')
  expect(sd.errorMsg.value).toBe('')
  sd.dispose()
})

it('records explicit cancellation against the saved queue key even before POST starts', async () => {
  const { useSDGenerate } = await import('./useSDGenerate')
  const attempt: RuntimeSdAttempt = { key: 'saved-key', rejected: vi.fn(), cancel: vi.fn().mockResolvedValue(undefined) }
  const sd = useSDGenerate(), work = sd.generate({ prompt: 'neutral fixture' }, { attempt })
  sd.cancel(); await work
  expect(attempt.cancel).toHaveBeenCalledOnce()
  expect(api.submit).not.toHaveBeenCalled(); expect(api.cancel).not.toHaveBeenCalled()
})

for (const duringSubmission of [true, false]) {
  it(`only a definitive POST rejection releases the saved attempt (submission=${duringSubmission})`, async () => {
    const { useSDGenerate } = await import('./useSDGenerate')
    const { ApiClientError } = await import('@/api/client')
    const error = new ApiClientError('fixture rejection', { kind: 'http', status: 409 })
    if (duringSubmission) api.submit.mockRejectedValueOnce(error)
    else api.wait.mockRejectedValueOnce(error)
    const attempt: RuntimeSdAttempt = { key: 'saved-key', rejected: vi.fn().mockResolvedValue(undefined), cancel: vi.fn() }
    await useSDGenerate().generate({ prompt: 'neutral fixture' }, { attempt })
    expect(attempt.rejected).toHaveBeenCalledTimes(duringSubmission ? 1 : 0)
    expect(api.submit).toHaveBeenCalledWith('generation', expect.any(Object), 'saved-key', undefined, expect.objectContaining({ signal: expect.any(AbortSignal) }))
  })
}
