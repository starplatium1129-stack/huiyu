import { beforeEach, expect, it, vi } from 'vitest'
import { ApiClientError } from '@/api/client'
import { AcceptedTaskTerminalError } from '@/api/acceptedTaskOutcome'
import { batchFailure } from './batchGenerationPlan'
import type { BatchDrawRunnerInput } from '../generation/useBatchDraw'
const api = vi.hoisted(() => ({ lookup: vi.fn() }))
vi.mock('@/api/runtimeTasks', () => ({ getRuntimeTaskByKey: api.lookup, waitForRuntimeTask: vi.fn(),
  fetchRuntimeResult: vi.fn(), runtimeResultPath: vi.fn(), taskMessage: () => 'runtime status' }))
beforeEach(() => vi.clearAllMocks())
function input(taskId?: string, reconnect = false): BatchDrawRunnerInput {
  return { scene: { id: 'scene', title: 'scene' }, seed: 0, variant: 0, requestKey: 'stable', taskId, reconnect,
    signal: new AbortController().signal, submitting: () => {}, accepted: async () => {} }
}
it.each([400, 429])('a definite unaccepted Web SD HTTP %s rejection remains retryable', async status => {
  const error = new ApiClientError('rejected', { kind: 'http', status })
  expect(await batchFailure(input(), error, false)).toEqual({ ok: false, error: 'rejected' })
  expect(api.lookup).not.toHaveBeenCalled()
})
it.each([400, 404, 429])('HTTP %s after legacy acceptance cannot prove a settled task', async status => {
  const error = new ApiClientError('read rejected', { kind: 'http', status })
  expect(await batchFailure(input('accepted'), error, false)).toMatchObject({ unresolved: true })
  expect(await batchFailure(input('accepted', true), error, false)).toMatchObject({ unresolved: true })
})
it.each(['failed', 'cancelled'] as const)('a bound legacy terminal %s response can be confirmed after reconnect', async status => {
  const error = new AcceptedTaskTerminalError('accepted', status, 'observed terminal')
  const result = await batchFailure(input('accepted', true), error, false)
  expect(result.unresolved).toBeUndefined(); expect(result.cancelled).toBe(status === 'cancelled')
  expect(await batchFailure(input('another-id', true), error, false)).toMatchObject({ unresolved: true })
})
it('aborted reads and malformed acceptance envelopes never prove non-admission or a terminal task', async () => {
  expect(await batchFailure(input(), new DOMException('read aborted', 'AbortError'), false)).toMatchObject({ unresolved: true })
  expect(await batchFailure(input('accepted'), new DOMException('read aborted', 'AbortError'), false)).toMatchObject({ unresolved: true })
  expect(await batchFailure(input(), new ApiClientError('invalid envelope', { kind: 'invalid-response', status: 200 }), false)).toMatchObject({ unresolved: true })
})
