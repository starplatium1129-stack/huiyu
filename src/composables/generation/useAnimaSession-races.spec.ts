import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'vitest'
import type { ApiClient, ApiRequestOptions } from '@/api/client'
import type { AnimaJobMetadata, AnimaResult } from '@/types/anima'
import { useAnimaSession, type AnimaRequest } from './useAnimaSession'

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
    request: <T extends object>(url: string, options?: ApiRequestOptions) => new Promise<T>((resolve, reject) => {
      calls.push({ url, options, resolve: value => resolve(value as T), reject })
    }),
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

afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

describe('useAnimaSession · stale asynchronous work', () => {
  it('cleans up a late accepted job through its original engine after a cross-engine retry', async () => {
    const { session, calls, generate } = fixture()
    const old = generate()
    const post = calls[0]
    await session.cancel()
    assert.equal(post.options?.signal?.aborted, true)
    session.patchState({ family: 'krea2' })
    const retry = generate()
    const newPost = calls[1]
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
    assert.equal(session.state.value.job, null)
    assert.equal(session.state.value.currentNode, null)
    await session.cancel()
    assert.equal(session.state.value.phase, 'cancelled')
    assert.equal(calls[0].options?.signal?.aborted, true)
    calls[0].resolve(accepted('late-retry'))
    await pending
    assert.equal(calls.at(-1)?.url, '/api/anima/jobs/late-retry')
  })

  for (const outcome of ['success', 'failure'] as const) {
    it(`ignores a delayed cancellation ${outcome} after a new generation starts`, async () => {
      const { session, calls, generate } = fixture()
      session.patchState({ phase: 'running', job: { id: 'old-job' } as AnimaJobMetadata })
      const cancellation = session.cancel()
      const deletion = calls[0]
      // The parallel status poll can confirm cancellation before DELETE settles.
      session.patchState({ phase: 'cancelled' })
      const retry = generate()
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
    session.patchState({ phase: 'succeeded', statusText: '生成完成' })
    calls[0].resolve(accepted('finished-job', 'cancelled'))
    await cancellation
    assert.equal(session.state.value.phase, 'succeeded')
    assert.equal(session.state.value.statusText, '生成完成')
  })

  it('invalidates an in-flight progress read once DELETE confirms cancellation', async () => {
    const { session, calls, generate } = fixture()
    const pending = generate()
    calls[0].resolve(accepted('running-job'))
    await flush()
    // Exercise the actual polling loop, not a synthetic state callback.
    const deadline = Date.now() + 2500
    while (calls.length < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(calls.length, 2)
    const progress = calls[1]
    const cancellation = session.cancel()
    calls[2].resolve(accepted('running-job', 'cancelled'))
    await cancellation
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

  it('discards a backend response after status polling is paused', async () => {
    const { session, calls } = fixture()
    const current = session.refreshBackend()
    session.pauseStatusPolling()
    const before = { ...session.state.value }
    calls[0].resolve({ ok: true, online: false, models: [] })
    await current
    assert.deepEqual(session.state.value, before)
  })
})
