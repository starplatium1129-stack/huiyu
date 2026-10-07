import assert from 'node:assert/strict'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient, ApiRequestOptions } from '@/api/client'
import type { AnimaJobMetadata, AnimaResult } from '@/types/anima'
import { useAnimaSession, type AnimaRequest } from './useAnimaSession'
import type { TaskRecord } from '../../../types/tasks'
// Load transport code outside the per-test clock; these races control HTTP
// completion order, not Vite's cold compilation of the direct transport.
import './animaJobPolling'

const runtime = vi.hoisted(() => ({ enabled: false, submit: vi.fn(), wait: vi.fn(), fetch: vi.fn(), cancel: vi.fn() }))
vi.mock('@/api/runtimeTaskAuthority', () => ({ hasRuntimeTasks: () => runtime.enabled }))
vi.mock('@/api/runtimeTasks', () => ({ submitRuntimeTask: runtime.submit, waitForRuntimeTask: runtime.wait,
  fetchRuntimeResult: runtime.fetch, cancelRuntimeTaskKey: runtime.cancel, runtimeResultPath: () => '/api/tasks/v1/one/results/0', taskMessage: () => 'Runtime state' }))

const request: AnimaRequest = {
  prompt: 'session race fixture', negative: '', profileId: 'default',
  modelId: 'anima-fixture', loraId: null, loraStrength: null,
  width: 832, height: 1216, steps: 20, cfg: 4, character: 'nene', adultEnabled: false,
}

function accepted(id: string, status = 'queued') {
  return { ok: true, job: { id, status, seed: 1, resultAvailable: false, resultUrl: null, error: null, code: null } }
}

interface PendingCall {
  url: string
  options?: ApiRequestOptions
  resolve: (value: object) => void
  reject: (error: unknown) => void
}

const cleanups: Array<() => Promise<void>> = []
async function flush() { for (let index = 0; index < 8; index++) await Promise.resolve() }

function fixture() {
  const calls: PendingCall[] = []
  const client = {
    request: <T extends object>(url: string, options?: ApiRequestOptions) => {
      // The local-chat release is a prerequisite, not one of the generation or
      // status requests whose completion order this fixture controls.
      if (url === '/api/local-setup/llama' && options?.method === 'DELETE') return Promise.resolve({ ok: true } as T)
      return new Promise<T>((resolve, reject) => {
        calls.push({ url, options, resolve: value => resolve(value as T), reject })
      })
    },
  } as unknown as ApiClient
  const session = useAnimaSession({
    getCharacter: () => 'nene', isPopular: () => false, getFamily: () => 'anima',
    getRequest: () => request, onResult: () => {}, flash: () => {},
    preferredSize: () => '832x1216', client,
  })
  session.patchState({ online: true })
  const generations: Promise<void>[] = []
  const generate = () => { const pending = session.generate(); generations.push(pending); return pending }
  cleanups.push(async () => {
    session.dispose()
    for (const call of calls) call.reject(new Error('fixture disposed'))
    await Promise.allSettled(generations)
  })
  return { session, calls, generate }
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  runtime.enabled = false; runtime.submit.mockReset(); runtime.wait.mockReset(); runtime.fetch.mockReset(); runtime.cancel.mockReset()
  vi.useRealTimers(); vi.unstubAllGlobals()
})

function durableFixture() {
  runtime.enabled = true
  const task = { taskId: 'runtime-task', kind: 'anima', provider: 'comfy', status: 'running', recoveryState: 'normal', createdAt: 1,
    input: { ...request, sampler: 'actual-sampler', scheduler: 'actual-scheduler', seed: 41 },
    metadata: { seed: 0, context: { char: 'nene', story: 'Frozen story' } },
  } as unknown as TaskRecord
  runtime.submit.mockResolvedValue(task)
  runtime.fetch.mockResolvedValue(new Blob(['pixels'], { type: 'image/png' }))
  vi.stubGlobal('URL', class extends URL { static createObjectURL = vi.fn(() => 'blob:runtime'); static revokeObjectURL = vi.fn() })
  const fixtureValue = fixture()
  function wait() {
    let resolve!: (value: TaskRecord) => void
    const pending = new Promise<TaskRecord>(done => { resolve = done })
    runtime.wait.mockImplementationOnce((_id: string, signal: AbortSignal, update: (value: TaskRecord) => void) => {
      update(task)
      return Promise.race([pending, new Promise<never>((_done, reject) => signal.addEventListener('abort', () => reject(new DOMException('unsubscribe', 'AbortError')), { once: true }))])
    })
    return (patch: Partial<TaskRecord> = {}) => resolve({ ...task, status: 'succeeded', ...patch })
  }
  return { ...fixtureValue, task, wait }
}

it('retains Krea runtime style processing, actual parameters and result context', async () => {
  const { session, task, generate } = durableFixture()
  session.patchState({ family: 'krea2' })
  runtime.wait.mockResolvedValueOnce({ ...task, kind: 'creative', metadata: { ...task.metadata, prompt: request.prompt + ', actual style trigger', steps: 12, cfg: 1, styleLoraId: 'style-a' } })
  await generate()
  expect(session.state.value.result?.metadata).toMatchObject({ engine: 'krea2', prompt: request.prompt + ', actual style trigger',
    seed: 0, steps: 12, cfg: 1, sampler: 'actual-sampler', styleLoraId: 'style-a' })
  expect(session.state.value.resultContext).toMatchObject({ story: 'Frozen story', history: { seed: 0, cfg: 1 } })
  expect(session.state.value.result?.metadata).not.toHaveProperty('context')
})

it('a late durable cancellation receipt cannot roll a completed image back to cancelling', async () => {
  const { session, task, generate, wait } = durableFixture()
  const finish = wait(), work = generate()
  await vi.waitFor(() => expect(runtime.wait).toHaveBeenCalledOnce())
  let receipt!: (value: TaskRecord) => void
  runtime.cancel.mockImplementationOnce(() => new Promise(resolve => { receipt = resolve }))
  const cancellation = session.cancel()
  await vi.waitFor(() => expect(runtime.cancel).toHaveBeenCalledOnce())
  finish(); await work
  receipt({ ...task, status: 'cancelled' }); await cancellation
  expect(session.state.value.phase).toBe('succeeded')
  expect(session.state.value.result?.url).toBe('blob:runtime')
})

it('a stale durable cancellation failure cannot overwrite a newer generation', async () => {
  const { session, generate, wait } = durableFixture()
  wait(); const old = generate()
  await vi.waitFor(() => expect(runtime.wait).toHaveBeenCalledOnce())
  let reject!: (reason: unknown) => void
  runtime.cancel.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
  const cancellation = session.cancel()
  await vi.waitFor(() => expect(runtime.cancel).toHaveBeenCalledOnce())
  session.patchState({ phase: 'cancelled' })
  const finish = wait(), retry = generate()
  await vi.waitFor(() => expect(runtime.wait).toHaveBeenCalledTimes(2))
  const before = { ...session.state.value }
  reject(new Error('Old receipt lost')); await cancellation
  expect(session.state.value).toEqual(before)
  finish(); await retry; await old
})

describe('useAnimaSession · stale asynchronous work', () => {
  it('cleans up a late accepted job through its original engine after a cross-engine retry', async () => {
    const { session, calls, generate } = fixture()
    const old = generate()
    await vi.waitFor(() => expect(calls.find(call => call.url === '/api/anima/jobs' && call.options?.method === 'POST')).toBeDefined())
    const post = calls.find(call => call.url === '/api/anima/jobs' && call.options?.method === 'POST')!
    await session.cancel()
    assert.equal(post.options?.signal?.aborted, true)
    session.patchState({ family: 'krea2' })
    const retry = generate()
    await vi.waitFor(() => expect(calls.find(call => call.url === '/api/creative/jobs' && call.options?.method === 'POST')).toBeDefined())
    const newPost = calls.find(call => call.url === '/api/creative/jobs' && call.options?.method === 'POST')!
    post.resolve(accepted('late-anima'))
    await old
    assert.equal(calls.at(-1)?.url, '/api/anima/jobs/late-anima')
    assert.equal(calls.at(-1)?.options?.method, 'DELETE')
    assert.equal(session.state.value.phase, 'submitting')
    newPost.resolve({ ok: false, error: 'finish retry fixture' })
    await retry
  })

  it('clears failed-job ownership before retrying and keeps submission cancellation usable', async () => {
    const { session, calls, generate } = fixture()
    session.patchState({ phase: 'failed', job: { id: 'previous-job' } as AnimaJobMetadata, currentNode: 'old-node' })
    const pending = generate()
    await vi.dynamicImportSettled()
    assert.equal(session.state.value.job, null)
    assert.equal(session.state.value.currentNode, null)
    await session.cancel()
    assert.equal(session.state.value.phase, 'cancelled')
    assert.equal(calls[0].options?.signal?.aborted, true)
    calls[0].resolve(accepted('late-retry'))
    await pending
    assert.equal(calls.at(-1)?.url, '/api/anima/jobs/late-retry')
    assert.equal(calls.at(-1)?.options?.method, 'DELETE')
    assert.equal(session.state.value.phase, 'cancelled')
  })

  for (const outcome of ['success', 'failure'] as const) {
    it(`ignores a delayed cancellation ${outcome} after a new generation starts`, async () => {
      const { session, calls, generate } = fixture()
      session.patchState({ phase: 'running', job: { id: 'old-job' } as AnimaJobMetadata })
      const cancellation = session.cancel()
    await vi.dynamicImportSettled()
      const deletion = calls[0]
      // The parallel status poll can confirm cancellation before DELETE settles.
      session.patchState({ phase: 'cancelled' })
      const retry = generate()
    await vi.dynamicImportSettled()
      const post = calls[1]
      if (outcome === 'success') deletion.resolve(accepted('old-job', 'cancelled'))
      else deletion.reject(new Error('old cancellation failed'))
      await cancellation
      assert.equal(session.state.value.phase, 'submitting')
      assert.equal(session.state.value.statusText, '提交任务…')
      assert.equal(session.state.value.errorMsg, '')
      post.resolve({ ok: false, error: 'finish retry fixture' })
      await retry
    })
  }

  it('does not replace a terminal success with a delayed cancellation acknowledgement', async () => {
    const { session, calls } = fixture()
    session.patchState({ phase: 'running', job: { id: 'finished-job' } as AnimaJobMetadata })
    const cancellation = session.cancel()
    await vi.dynamicImportSettled()
    session.patchState({ phase: 'succeeded', statusText: '生成完成' })
    calls[0].resolve(accepted('finished-job', 'cancelled'))
    await cancellation
    assert.equal(session.state.value.phase, 'succeeded')
    assert.equal(session.state.value.statusText, '生成完成')
  })

  it('invalidates an in-flight progress read once DELETE confirms cancellation', async () => {
    vi.useFakeTimers()
    const { session, calls, generate } = fixture()
    const pending = generate()
    await vi.dynamicImportSettled()
    calls[0].resolve(accepted('running-job'))
    await flush()
    session.patchState({ family: 'krea2' })
    await vi.dynamicImportSettled()
    await vi.advanceTimersByTimeAsync(1000)
    assert.equal(calls.length, 2)
    const progress = calls[1]
    assert.equal(progress.url, '/api/anima/jobs/running-job')
    const cancellation = session.cancel()
    await vi.dynamicImportSettled()
    assert.equal(calls[2].url, '/api/anima/jobs/running-job')
    assert.equal(calls[2].options?.method, 'DELETE')
    calls[2].resolve(accepted('running-job', 'cancelled'))
    await cancellation
    assert.equal(session.state.value.phase, 'cancelled')
    assert.equal(calls.filter(call => call.options?.method === 'DELETE').length, 1)
    const stateAfterCancel = { ...session.state.value }
    progress.resolve({ ...accepted('running-job', 'running'), job: { ...accepted('running-job').job, status: 'running', progress: 0.9, currentNode: 'stale-node' } })
    await flush()
    assert.deepEqual(session.state.value, stateAfterCancel)
    await pending
  })

  it('keeps a restored result when a cancelled submission resolves late', async () => {
    const { session, calls, generate } = fixture()
    const previous: AnimaResult = {
      url: 'blob:fixture-result', blob: new Blob(['fixture'], { type: 'image/png' }),
      metadata: { id: 'previous-success' } as AnimaJobMetadata,
    }
    session.patchState({ phase: 'succeeded', result: previous, job: previous.metadata })
    const pending = generate()
    await vi.dynamicImportSettled()
    await session.cancel()
    assert.equal(session.restoreStashedResult(), true)
    calls[0].resolve(accepted('late-job'))
    await pending
    assert.equal(session.state.value.phase, 'succeeded')
    assert.equal(session.state.value.result?.url, previous.url)
    assert.equal(session.state.value.statusText, '已恢复上一张未入册的成片')
  })

  for (const outcome of ['success', 'failure'] as const) {
    it(`ignores an older backend status ${outcome} after a newer refresh succeeds`, async () => {
      const { session, calls } = fixture()
      const old = session.refreshBackend()
      const current = session.refreshBackend()
      calls[1].resolve({ ok: true, online: true, models: [{ id: 'new-model', family: 'anima', available: true }] })
      await current
      assert.equal(session.state.value.online, true)
      if (outcome === 'success') calls[0].resolve({ ok: true, online: false, models: [] })
      else calls[0].reject(new Error('stale network failure'))
      await old
      assert.equal(session.state.value.online, true)
      assert.equal(session.state.value.modelId, 'new-model')
    })
  }

  it.each(['success', 'failure'])('waits for replacement discovery when the superseded request ends with %s first', async outcome => {
    const { session, calls } = fixture()
    let settled = false
    const old = session.refreshBackend().then(checked => { settled = true; return checked })
    const current = session.refreshBackend()
    expect(calls[0].options?.signal?.aborted).toBe(true)
    if (outcome === 'success') calls[0].resolve({ ok: true, online: false, models: [] })
    else calls[0].reject(new Error('superseded request'))
    await flush()
    expect(settled).toBe(false)
    calls[1].resolve({ ok: true, online: true, models: [{ id: 'replacement', family: 'anima', available: true }] })
    expect(await current).toBe(true)
    expect(await old).toBe(true)
    expect(session.state.value.modelId).toBe('replacement')
  })

  it('discards a backend response after status polling is paused', async () => {
    const { session, calls } = fixture()
    session.patchState({ phase: 'running' })
    const current = session.refreshBackend()
    session.pauseStatusPolling()
    assert.equal(calls[0].options?.signal?.aborted, true)
    const before = { ...session.state.value }
    calls[0].resolve({ ok: true, online: false, models: [] })
    expect(await current).toBe(false)
    assert.deepEqual(session.state.value, before)
  })

  it.each(['submitting', 'running'])('dispose cancels %s ownership and deletes a late or already accepted job', async phase => {
    vi.useFakeTimers()
    const { session, calls, generate } = fixture()
    const pending = generate()
    await vi.dynamicImportSettled()
    if (phase === 'running') { calls[0].resolve(accepted('disposed-job', 'running')); await flush() }
    session.startStatusPolling()
    session.dispose()
    const before = { ...session.state.value }
    assert.equal(calls[0].options?.signal?.aborted, true)
    if (phase === 'submitting') calls[0].resolve(accepted('disposed-job'))
    await vi.advanceTimersByTimeAsync(1000)
    await pending
    assert.equal(calls.at(-1)?.url, '/api/anima/jobs/disposed-job')
    assert.equal(calls.at(-1)?.options?.method, 'DELETE')
    assert.deepEqual(session.state.value, before)
    assert.equal(vi.getTimerCount(), 0)
  })
})
