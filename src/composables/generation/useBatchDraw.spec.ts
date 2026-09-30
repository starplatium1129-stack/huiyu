import { afterEach, expect, it, vi } from 'vitest'
import { useBatchDraw, type BatchDrawRunnerInput, type BatchTargetItem } from './useBatchDraw'
import { parseBatchDrawPlan, type BatchDrawPlan, type BatchDrawPlanStorage } from './batchDrawPlan'

afterEach(() => vi.restoreAllMocks())
const items: BatchTargetItem[] = [{ id: 'scene', title: '原场景', prose: 'original scene', kind: 'scene' }]
function memoryStorage() {
  let saved: BatchDrawPlan | null = null
  const storage: BatchDrawPlanStorage = {
    read: () => saved ? parseBatchDrawPlan(JSON.parse(JSON.stringify(saved))) : null,
    write: vi.fn(async plan => { saved = JSON.parse(JSON.stringify(plan)) as BatchDrawPlan }),
    clear: vi.fn(async () => { saved = null }),
  }
  return { storage, saved: () => saved }
}
const prepare = (input: BatchDrawRunnerInput) => ({ prompt: input.scene.prose, model: 'original model', seed: input.seed })

it('refresh restores frozen serial planning without a request and resumes the accepted task by the same identity', async () => {
  const { storage, saved } = memoryStorage()
  let release!: () => void
  const wait = new Promise<void>(resolve => { release = resolve })
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  const original = useBatchDraw({ storage, prepare, run: async input => {
    await input.accepted('accepted-task'); await wait
    return { ok: true, resultUrl: 'blob:late-result' }
  } })
  const work = original.start(items, 3, 42, '个场景', { engine: 'anima', runtimeOwned: true })
  await vi.waitFor(() => expect(original.jobs.value[0].status).toBe('accepted'))
  const key = original.jobs.value[0].requestKey
  original.dispose(); release(); await work
  expect(revoke).toHaveBeenCalledWith('blob:late-result')
  expect(saved()?.jobs.map(job => job.status)).toEqual(['unknown', 'pending', 'pending'])
  const run = vi.fn(async (input: BatchDrawRunnerInput) => {
    if (input.reconnect) { expect(input.requestKey).toBe(key); expect(input.taskId).toBe('accepted-task') }
    expect(input.snapshot?.model).toBe('original model')
    return { ok: true, historyId: input.variant }
  })
  const restored = useBatchDraw({ storage, run })
  expect(restored.restored.value).toBe(true); expect(restored.running.value).toBe(false)
  expect(run).not.toHaveBeenCalled()
  await restored.resume()
  expect(run.mock.calls.map(([input]) => input.reconnect)).toEqual([true, false, false])
  expect(run.mock.calls.map(([input]) => input.seed)).toEqual([42, 1042, 2042])
  expect(restored.progress.value.succeeded).toBe(3)
})

it('unknown admission pauses the rest, excludes failure retry, and every manual reconciliation retains the original key', async () => {
  const { storage } = memoryStorage()
  const run = vi.fn(async (_input: BatchDrawRunnerInput) => ({ ok: false, unresolved: true, error: 'receipt lost' }))
  const batch = useBatchDraw({ storage, prepare, run })
  await batch.start(items, 3, 0, '个场景', { runtimeOwned: true })
  const key = batch.jobs.value[0].requestKey
  expect(run).toHaveBeenCalledTimes(1)
  expect(batch.progress.value).toMatchObject({ unresolved: 1, remaining: 2, done: 0 })
  await batch.retryFailed(); await batch.reset(); await batch.start(items, 1, 9)
  expect(run).toHaveBeenCalledTimes(1); expect(batch.jobs.value).toHaveLength(3)
  const restored = useBatchDraw({ storage, run })
  expect(run).toHaveBeenCalledTimes(1)
  await restored.resume()
  const input = run.mock.calls.at(-1)?.[0] as unknown as BatchDrawRunnerInput
  expect(input.reconnect).toBe(true); expect(input.requestKey).toBe(key)
  expect(run).toHaveBeenCalledTimes(2); expect(restored.progress.value.remaining).toBe(2)
})

it('only a confirmed failed accepted task receives a new attempt identity, retaining frozen input', async () => {
  const { storage } = memoryStorage()
  const inputs: BatchDrawRunnerInput[] = []
  const target = { ...items[0] }
  const batch = useBatchDraw({ storage, prepare, run: async input => {
    inputs.push({ ...input })
    await input.accepted('settled-failed-task')
    return { ok: inputs.length > 1, error: 'confirmed failure' }
  } })
  await batch.start([target], 1, 0, '个场景', { runtimeOwned: true })
  target.prose = 'changed after submission'
  await batch.retryFailed()
  expect(inputs[0].requestKey).not.toBe(inputs[1].requestKey)
  expect(inputs[1].snapshot).toEqual({ prompt: 'original scene', model: 'original model', seed: 0 })
  expect(batch.progress.value.succeeded).toBe(1)
})

it('stops before model admission if the request identity cannot be saved', async () => {
  const { storage } = memoryStorage()
  vi.mocked(storage.write).mockRejectedValueOnce(new Error('profile disconnected'))
  const run = vi.fn(async () => ({ ok: true }))
  const batch = useBatchDraw({ storage, prepare, run })
  await batch.start(items, 1, 0)
  expect(run).not.toHaveBeenCalled(); expect(batch.storageError.value).toContain('profile disconnected')
  expect(batch.jobs.value[0].status).toBe('pending')
  await batch.resume()
  expect(run).toHaveBeenCalledOnce(); expect(batch.storageError.value).toBe('')
})

it('explicit stop preserves the current result and requires continue for unexecuted jobs', async () => {
  const { storage } = memoryStorage()
  const run = vi.fn(async () => { if (run.mock.calls.length === 1) batch.cancel(); return { ok: true } })
  const batch = useBatchDraw({ storage, prepare, run })
  await batch.start(items, 3, 0)
  expect(batch.jobs.value.map(job => job.status)).toEqual(['succeeded', 'cancelled', 'cancelled'])
  const restored = useBatchDraw({ storage, run })
  expect(run).toHaveBeenCalledOnce()
  await restored.resume()
  expect(run).toHaveBeenCalledTimes(3); expect(restored.progress.value.succeeded).toBe(3)
})

it('a late accepted response after disposal cannot overwrite a newer restored plan', async () => {
  const { storage, saved } = memoryStorage()
  let accept!: () => void
  const blocked = new Promise<void>(resolve => { accept = resolve })
  const batch = useBatchDraw({ storage, prepare, run: async input => {
    input.submitting()
    await blocked; await input.accepted('late-task')
    return { ok: false, unresolved: true }
  } })
  const work = batch.start(items, 1, 0, '个场景', { runtimeOwned: true })
  await vi.waitFor(() => expect(batch.running.value).toBe(true))
  batch.dispose()
  const restored = useBatchDraw({ storage, run: async () => ({ ok: true, historyId: 'saved-on-new-page' }) })
  await restored.resume(); accept(); await work
  expect(saved()?.jobs[0]).toMatchObject({ status: 'succeeded', historyId: 'saved-on-new-page' })
})

it('leaving while the identity write is pending preserves a retryable pending item and never enters the provider', async () => {
  let release!: () => void, writes = 0, saved: BatchDrawPlan | null = null
  const gate = new Promise<void>(resolve => { release = resolve })
  const storage: BatchDrawPlanStorage = { read: () => saved ? parseBatchDrawPlan(saved) : null, clear: async () => {},
    write: async plan => { if (++writes === 1) await gate; saved = JSON.parse(JSON.stringify(plan)) as BatchDrawPlan } }
  const run = vi.fn(async () => ({ ok: true }))
  const batch = useBatchDraw({ storage, prepare, run })
  const work = batch.start(items, 1, 0, '个场景', { runtimeOwned: true })
  await vi.waitFor(() => expect(writes).toBe(1))
  batch.dispose(); release(); await work
  await vi.waitFor(() => expect(writes).toBe(2))
  expect(run).not.toHaveBeenCalled()
  const restored = useBatchDraw({ storage, run })
  expect(restored.jobs.value[0].status).toBe('pending'); expect(restored.progress.value.unresolved).toBe(0)
  await restored.resume(); expect(run).toHaveBeenCalledOnce()
})

it('an async runner preparation that has not reached its submission hook remains pending on disposal', async () => {
  const { storage, saved } = memoryStorage()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const provider = vi.fn()
  const batch = useBatchDraw({ storage, prepare, run: async input => {
    await gate; input.submitting(); provider(); return { ok: true }
  } })
  const work = batch.start(items, 1, 0, '个场景', { runtimeOwned: true })
  await vi.waitFor(() => expect(batch.jobs.value[0].status).toBe('running'))
  batch.dispose(); release(); await work
  expect(provider).not.toHaveBeenCalled()
  await vi.waitFor(() => expect(saved()?.jobs[0].status).toBe('pending'))
})

it('reset holds the same exclusion boundary through asynchronous clear', async () => {
  const { storage } = memoryStorage()
  const run = vi.fn(async () => ({ ok: false, error: 'definite failure' }))
  const batch = useBatchDraw({ storage, prepare, run })
  await batch.start(items, 1, 0)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const clear = storage.clear
  storage.clear = vi.fn(async () => { await gate; await clear() })
  const resetting = batch.reset()
  expect(batch.resetting.value).toBe(true)
  await batch.retryFailed(); await batch.start(items, 1, 8); await batch.resume()
  expect(run).toHaveBeenCalledOnce(); expect(batch.jobs.value).toHaveLength(1)
  release(); await resetting
  expect(batch.resetting.value).toBe(false); expect(batch.jobs.value).toHaveLength(0)
  await batch.start(items, 1, 9)
  expect(run).toHaveBeenCalledTimes(2)
})
