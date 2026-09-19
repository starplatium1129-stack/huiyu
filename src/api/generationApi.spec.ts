import { afterEach, expect, it, vi } from 'vitest'
import { createApiClient, type FetchImplementation } from './client'
import { createGenerationApi, GENERATION_API_TIMEOUTS } from './generationApi'
import { generationTask } from '@/utils/generationTask'

const response = (body: unknown) => createGenerationApi(createApiClient(async () => Response.json(body)))
const job = { id: 'job/1', status: 'running', provider: 'comfy' }
afterEach(() => vi.useRealTimers())

it.each([
  {}, { ok: true }, { ok: true, job: [] }, { job },
  ...[{ status: undefined }, { status: 1 }, { status: '' }, { provider: 'other' },
    { provider: undefined }, { progress: '0.2' }, { progress: -1 }, { progress: 1.2 },
    { resultAvailable: 'yes' }, { metadata: [] }, { metadata: { seed: '1' } },
    { elapsedSeconds: -1 }, { seed: {} }].map(fields => ({ ok: true, job: { ...job, ...fields } })),
])('rejects malformed wire fields: %j', async body => {
  await expect(response(body).getJob('job/1')).rejects.toMatchObject({ kind: 'invalid-response' })
})

it.each(['queued', 'loading', 'running', 'succeeded', 'failed', 'cancelled', 'future-stage'])('preserves %s and delegates UI stage mapping', async status => {
  const result = await response({ ok: true, job: { ...job, status, progress: null, metadata: { seed: 0, extension: true } } }).getJob('job/1')
  expect(result.job.status).toBe(status)
  expect(result.job.progress).toBeNull()
  if (status === 'future-stage') expect(generationTask(result.job.status).stage).toBe('unknown')
  expect(result.job.metadata).toEqual({ seed: 0, extension: true })
})

it('accepts WebUI absent progress, Comfy fraction progress and legal seed zero', async () => {
  expect((await response({ ok: true, job: { ...job, provider: 'webui', seed: 0 } }).getJob('id')).job).toMatchObject({ progress: null, seed: 0 })
  expect((await response({ ok: true, job: { ...job, progress: .25 } }).getJob('id')).job.progress).toBe(.25)
})

it.each(['abort', 'timeout'])('retains transport %s semantics', async cause => {
  vi.useFakeTimers()
  const fetcher = vi.fn<FetchImplementation>((_url, init) => new Promise((_yes, no) =>
    init?.signal?.addEventListener('abort', () => no(new DOMException('aborted', 'AbortError')), { once: true })))
  const controller = new AbortController()
  const pending = createGenerationApi(createApiClient(fetcher)).getJob('job/1', { signal: controller.signal })
  const rejected = expect(pending).rejects.toMatchObject({ kind: cause === 'abort' ? 'aborted' : 'timeout' })
  if (cause === 'abort') controller.abort()
  else await vi.advanceTimersByTimeAsync(GENERATION_API_TIMEOUTS.job)
  await rejected
  expect(fetcher.mock.calls[0][0]).toBe('/api/generation/jobs/job%2F1')
  expect(vi.getTimerCount()).toBe(0)
})

