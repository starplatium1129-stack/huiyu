import { beforeEach, expect, it, vi } from 'vitest'
import { queryTask, cancelRecoveredTask } from './taskRecovery'
import type { TaskRecord } from '@/composables/useTaskCenter'

const api = vi.hoisted(() => ({ fetchVideoJob: vi.fn(), fetchVideoBatch: vi.fn(), cancelVideoJob: vi.fn(), cancelVideoBatch: vi.fn() }))
vi.mock('@/api/videoApi', () => api)
beforeEach(() => Object.values(api).forEach(fn => fn.mockReset()))
const task = (kind: 'video' | 'video-batch' = 'video') => ({ id: 'summary', route: '/video-studio?job=one', backend: { kind, id: 'one' } } as TaskRecord)

it('queries the saved backend identity without submitting a new job', async () => {
  api.fetchVideoJob.mockResolvedValue({ job: { status: 'running', progress: .4 } })
  expect(await queryTask(task())).toMatchObject({ status: 'running', progress: 40 })
  expect(api.fetchVideoJob).toHaveBeenCalledWith('one', undefined)
})
it('completion exposes the exact saved workspace route', async () => {
  api.fetchVideoJob.mockResolvedValue({ job: { status: 'succeeded', progress: 1 } })
  expect(await queryTask(task())).toMatchObject({ status: 'succeeded', resultRoute: task().route })
})
it('partial batch failures remain actionable', async () => {
  api.fetchVideoBatch.mockResolvedValue({ batch: { status: 'paused', progress: { succeeded: 2, failed: 1, total: 4 } } })
  expect(await queryTask(task('video-batch'))).toMatchObject({ status: 'failed', progress: 75 })
})
it('network errors remain errors rather than fabricated cancellation or completion', async () => {
  api.fetchVideoJob.mockRejectedValue(new Error('offline'))
  await expect(queryTask(task())).rejects.toThrow('offline')
})
it('cancellation uses the provider-specific endpoint', async () => {
  await cancelRecoveredTask(task())
  await cancelRecoveredTask(task('video-batch'))
  expect(api.cancelVideoJob).toHaveBeenCalledWith('one', undefined)
  expect(api.cancelVideoBatch).toHaveBeenCalledWith('one', undefined)
  const controller = new AbortController()
  const pending = cancelRecoveredTask(task(), controller.signal)
  controller.abort()
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  expect(api.cancelVideoJob).toHaveBeenCalledTimes(1)
})
