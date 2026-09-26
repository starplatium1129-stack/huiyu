import { afterEach, expect, it, vi } from 'vitest'
import { createBatchAnimaTransport } from './batchAnimaJob'
import { animaRequestPayload, type AnimaRequest } from '../generation/useAnimaSession'

const mocks = vi.hoisted(() => ({ submit: vi.fn(), wait: vi.fn(), fetch: vi.fn() }))
vi.mock('@/api/runtimeTaskAuthority', () => ({ hasRuntimeTasks: () => true, runtimeRequestKey: () => 'stable-key' }))
vi.mock('@/api/runtimeTasks', () => ({ hasRuntimeTasks: () => true, runtimeRequestKey: () => 'stable-key',
  submitRuntimeTask: mocks.submit, waitForRuntimeTask: mocks.wait, fetchRuntimeResult: mocks.fetch,
  runtimeResultPath: () => '/api/tasks/v1/accepted/results/0', taskMessage: () => '核对中' }))
afterEach(() => vi.clearAllMocks())
const input = { prompt: 'unchanged input', negative: 'unchanged negative', modelId: 'fixture-model', width: 832, height: 1216,
  seed: 0, steps: 30, cfg: 4.5, loraId: null, hiresFix: true, hiresScale: 1.5, hiresDenoise: .3 } as AnimaRequest
const task = { taskId: 'accepted', requestKey: 'stable-key', input: { seed: 0 }, metadata: {}, upstreamSettled: true, status: 'succeeded' }

it('keeps every submitted engine field and reuses an accepted unknown task during manual retry', async () => {
  const transport = createBatchAnimaTransport(() => 'anima'), context = { history: { outfitId: 'fixture' } }
  mocks.submit.mockResolvedValue(task)
  mocks.wait.mockRejectedValueOnce(new Error('状态未确认')).mockResolvedValueOnce(task)
  mocks.fetch.mockResolvedValue(new Blob(['image'], { type: 'image/png' }))
  await expect(transport.run(input, context, () => false)).rejects.toThrow('状态未确认')
  const result = await transport.run(input, context, () => false)
  expect(mocks.submit).toHaveBeenCalledExactlyOnceWith('anima', animaRequestPayload(input), 'stable-key', context)
  expect(result.taskId).toBe('accepted'); expect(result.seed).toBe(0)
})

it('unloading stops observation without cancelling or resubmitting a late accepted task', async () => {
  const transport = createBatchAnimaTransport(() => 'krea2')
  let accept!: (value: unknown) => void
  mocks.submit.mockImplementation(() => new Promise(resolve => { accept = resolve }))
  const result = transport.run(input, {}, () => false)
  await vi.waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1))
  transport.dispose(); accept(task)
  await expect(result).rejects.toMatchObject({ name: 'AbortError' })
  expect(mocks.submit).toHaveBeenCalledTimes(1); expect(mocks.wait).not.toHaveBeenCalled()
})
