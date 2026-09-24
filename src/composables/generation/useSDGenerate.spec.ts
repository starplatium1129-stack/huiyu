import { afterEach, expect, it, vi } from 'vitest'
import { useSDGenerate } from './useSDGenerate'

const api = vi.hoisted(() => ({ createJob: vi.fn(), getJob: vi.fn(), deleteJob: vi.fn().mockResolvedValue({}) }))
vi.mock('@/api/generationApi', () => ({ generationApi: api }))
vi.mock('@/utils/runtimeEnvironment', () => ({ isLocalStudioHost: () => false }))
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks() })

it('freezes lazy submission input and preserves zero LoRA strength', async () => {
  api.createJob.mockResolvedValue({ job: { id: 'failed', status: 'failed', error: 'fixture failure' } })
  const sd = useSDGenerate()
  const params = { prompt: 'A quiet park', lora: 'ayachi_nene_v18_wd14:0' }
  const request = sd.generate(params)
  params.prompt = 'Changed after click'
  await request
  expect(api.createJob).toHaveBeenCalledWith(expect.objectContaining({ prompt: expect.stringContaining('A quiet park'), loras: [{ id: 'L_NENE_V18_WD14', strength: 0 }] }), expect.anything())
  expect(sd.taskState.value).toBe('failed')
  sd.dispose()
})
it('deletes an accepted job when the client deadline expires', async () => {
  let now = Date.now()
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  api.createJob.mockResolvedValue({ job: { id: 'timeout', status: 'queued' } })
  api.getJob.mockImplementation(async () => {
    now += 21 * 60 * 1000
    return { job: { id: 'timeout', status: 'running' } }
  })
  const sd = useSDGenerate()
  await expect(sd.generate({ prompt: 'Timeout fixture' })).resolves.toBeNull()
  expect(api.deleteJob).toHaveBeenCalledWith('timeout')
  expect(sd.taskState.value).toBe('failed')
  sd.dispose()
})

it('a stop before lazy initialization never submits a model request', async () => {
  const sd = useSDGenerate()
  const request = sd.generate({ prompt: 'Neutral fixture' })
  sd.cancel()
  await request
  expect(api.createJob).not.toHaveBeenCalled()
  expect(sd.taskState.value).toBe('cancelled')
  sd.dispose()
})
it('late acceptance after cancellation is explicitly deleted and stays cancelled', async () => {
  let resolve!: (response: object) => void
  api.createJob.mockImplementation(() => new Promise(yes => { resolve = yes }))
  const sd = useSDGenerate()
  const request = sd.generate({ prompt: 'Neutral fixture' })
  await vi.waitFor(() => expect(api.createJob).toHaveBeenCalled())
  sd.cancel()
  resolve({ job: { id: 'late', status: 'queued' } })
  await request
  expect(api.deleteJob).toHaveBeenCalledWith('late')
  expect(sd.taskState.value).toBe('cancelled')
  sd.dispose()
})
