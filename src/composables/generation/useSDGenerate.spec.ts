import { afterEach, expect, it, vi } from 'vitest'
import { useLegacySdTasks } from './useLegacySdTasks'
const api = vi.hoisted(() => ({ getJob: vi.fn(), deleteJob: vi.fn().mockResolvedValue({}), createJob: vi.fn() }))
vi.mock('@/api/generationApi', () => ({ generationApi: api }))
vi.mock('@/utils/runtimeEnvironment', () => ({ isLocalStudioHost: () => false }))
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

it('rejects a missing legacy identity without creating a task', async () => {
  const sd = useLegacySdTasks()
  expect(await sd.observe({ prompt: 'A quiet park' })).toBeNull()
  expect(sd.errorMsg.value).toContain('退役')
  expect(api.getJob).not.toHaveBeenCalled(); expect(api.createJob).not.toHaveBeenCalled()
  sd.dispose()
})
it('an observation deadline does not delete or mark the server task failed', async () => {
  vi.useFakeTimers()
  api.getJob.mockResolvedValue({ job: { id: 'timeout', status: 'queued' } })
  const sd = useLegacySdTasks()
  const work = sd.observe({ prompt: 'Timeout fixture' }, { resumeId: 'timeout' })
  await vi.waitFor(() => expect(sd.taskState.value).toBe('queued'))
  vi.setSystemTime(Date.now() + 21 * 60 * 1000)
  await vi.advanceTimersByTimeAsync(700)
  expect(await work).toBeNull()
  expect(api.deleteJob).not.toHaveBeenCalled(); expect(sd.taskState.value).toBe('unknown')
  sd.dispose()
})
it('an explicit stop during a cold read cancels only its original ID', async () => {
  const sd = useLegacySdTasks()
  const work = sd.observe({ prompt: 'Neutral fixture' }, { resumeId: 'known' })
  sd.cancel(); await work
  await vi.waitFor(() => expect(api.deleteJob).toHaveBeenCalledWith('known'))
  expect(api.createJob).not.toHaveBeenCalled(); expect(sd.taskState.value).toBe('cancelled')
  sd.dispose()
})
it('a late read after cancellation cannot publish a result', async () => {
  let finish!: (value: object) => void
  api.getJob.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const sd = useLegacySdTasks()
  const work = sd.observe({ prompt: 'Neutral fixture' }, { resumeId: 'late' })
  await vi.waitFor(() => expect(finish).toBeDefined())
  sd.cancel(); finish({ job: { id: 'late', status: 'queued' } }); await work
  await vi.waitFor(() => expect(api.deleteJob).toHaveBeenCalledWith('late'))
  expect(sd.taskState.value).toBe('cancelled')
  sd.dispose()
})
it.each([
  { received: 'comfy', provider: 'comfy', label: 'ComfyUI' },
  { received: undefined, provider: 'webui', label: 'SD WebUI' },
])('observes $provider progress without inventing percentages', async ({ received, provider, label }) => {
  vi.useFakeTimers()
  api.getJob.mockResolvedValueOnce({ job: { id: 'progress', status: 'queued', provider: received } })
    .mockResolvedValueOnce({ job: { id: 'progress', status: 'running' } })
    .mockResolvedValueOnce({ job: { id: 'progress', status: 'running', progress: 0.375 } })
    .mockResolvedValueOnce({ job: { id: 'progress', status: 'succeeded', resultUrl: '/progress.png' } })
  const sd = useLegacySdTasks()
  let terminalProgress: number | null = null
  vi.stubGlobal('fetch', vi.fn(async () => {
    terminalProgress = sd.progress.value
    return new Response(new Blob(['fixture'], { type: 'image/png' }), { headers: { 'content-type': 'image/png' } })
  }))
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:progress')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  const work = sd.observe({ prompt: 'Progress fixture' }, { resumeId: 'progress' })
  await vi.waitFor(() => expect(sd.taskState.value).toBe('queued'))
  expect(sd.provider.value).toBe(provider)
  await vi.advanceTimersByTimeAsync(700)
  expect(sd.progress.value).toBeNull(); expect(sd.statusText.value).toContain(label)
  await vi.advanceTimersByTimeAsync(350); expect(sd.progress.value).toBeNull()
  await vi.advanceTimersByTimeAsync(350); expect(sd.progress.value).toBe(38)
  await vi.advanceTimersByTimeAsync(700)
  expect(await work).toBe('blob:progress'); expect(terminalProgress).toBe(100)
  expect(api.createJob).not.toHaveBeenCalled(); sd.dispose()
})
