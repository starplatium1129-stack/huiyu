import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { watch } from 'vue'
import type { TaskRecord } from '../../types/tasks'

let epochSequence = 0
const mocks = vi.hoisted(() => ({ request: vi.fn(), epoch: 'one' }))
vi.mock('./client', () => ({ apiClient: { request: mocks.request }, ApiClientError: class extends Error {} }))
vi.mock('../platform/desktop/runtime.ts', () => ({
  getDesktopRuntime: () => ({ connection: 'ready', bootstrap: { runtime: { workspace: {
    runtimeEpoch: mocks.epoch, workspaceId: 'fixture', domains: ['artwork'],
  } } } }),
  desktopRuntimeFetch: vi.fn(), onDesktopRuntime: vi.fn(),
}))
import { refreshRuntimeTasks, getRuntimeTask, waitForRuntimeTask } from './runtimeTasks'
import { AcceptedTaskTerminalError } from './acceptedTaskOutcome'
import { taskRecords, runtimeTasks, runtimeTaskActiveCount, runtimeTaskError, unresolvedTaskRequests, pendingTaskRequests, mergeTasks } from '../stores/runtimeTaskState'

const task = (id: number, revision = 1): TaskRecord => ({
  taskId: String(id), runtimeEpoch: mocks.epoch, revision, createdAt: id,
  requestKey: `request-${id}`, status: 'running', upstreamSettled: false,
  input: { prompt: 'neutral fixture '.repeat(100) }, metadata: { nested: { value: id } }, resultRefs: [],
} as unknown as TaskRecord)
function respond(items: TaskRecord[], nextCursor: number | null = null, throughRevision = 100) {
  mocks.request.mockResolvedValueOnce({ result: { items, nextCursor, throughRevision }, runtimeEpoch: mocks.epoch })
}
beforeEach(() => {
  mocks.epoch = 'epoch-' + ++epochSequence; mocks.request.mockReset()
  taskRecords.value = []; unresolvedTaskRequests.clear(); pendingTaskRequests.value = []
})
afterEach(() => vi.restoreAllMocks())

it.each(['failed', 'cancelled'] as const)('reports an observed %s outcome by accepted identity', async status => {
  const observed = { ...task(1), status, recoveryState: 'normal', upstreamSettled: true, resultState: 'none' } as TaskRecord
  mocks.request.mockResolvedValueOnce({ result: observed, runtimeEpoch: mocks.epoch })
  const update = vi.fn()
  await expect(waitForRuntimeTask('1', new AbortController().signal, update)).rejects.toMatchObject({ taskId: '1', status })
  expect(update).toHaveBeenCalledWith(expect.objectContaining({ status }))
})

it('does not turn an unknown accepted job into a terminal failure', async () => {
  const observed = { ...task(1), recoveryState: 'unknown', upstreamSettled: false } as TaskRecord
  mocks.request.mockResolvedValueOnce({ result: observed, runtimeEpoch: mocks.epoch })
  const error = await waitForRuntimeTask('1', new AbortController().signal, vi.fn()).catch(value => value)
  expect(error).not.toBeInstanceOf(AcceptedTaskTerminalError)
  expect(error.message).toContain('状态尚未确认')
})

describe('runtime task snapshot merging', () => {
  it('bounds terminal history while retaining every active and uncertain task and cloning only changed views', () => {
    const active = Array.from({ length: 130 }, (_, id) => ({ ...task(id, id + 1), recoveryState: 'normal' as const }))
    const finished = Array.from({ length: 1000 }, (_, id) => ({ ...task(id + 130, id + 131), recoveryState: 'normal' as const, status: 'succeeded' as const, upstreamSettled: true }))
    const uncertain = { ...task(2000, 1), recoveryState: 'unknown' as const, upstreamSettled: true }
    mergeTasks([...active, ...finished, uncertain], mocks.epoch)
    expect(taskRecords.value).toHaveLength(191)
    expect(runtimeTaskActiveCount.value).toBe(130)
    expect(taskRecords.value.some(item => item.taskId === '2000')).toBe(true)
    expect(runtimeTasks.value.every(item => !('input' in item))).toBe(true)
    const clone = vi.spyOn(globalThis, 'structuredClone')
    mergeTasks([{ ...active[0], revision: 3000 }], mocks.epoch)
    expect(runtimeTasks.value).toHaveLength(191)
    expect(clone).toHaveBeenCalledTimes(2)
  })
  it('does not clone or invalidate 100 unchanged tasks on an idle poll', async () => {
    respond(Array.from({ length: 100 }, (_, id) => task(id)))
    await refreshRuntimeTasks()
    const stored = taskRecords.value, projected = runtimeTasks.value
    const clone = vi.spyOn(globalThis, 'structuredClone')
    respond(Array.from({ length: 100 }, (_, id) => task(id)))
    await refreshRuntimeTasks()
    expect(taskRecords.value).toBe(stored)
    expect(runtimeTasks.value).toBe(projected)
    expect(clone).not.toHaveBeenCalled()
  })

  it('publishes a list once, copies only changed inputs and keeps older revisions out', async () => {
    respond([task(1, 2), task(2, 2)])
    await refreshRuntimeTasks()
    const unchanged = taskRecords.value.find(item => item.taskId === '1')
    expect(runtimeTaskActiveCount.value).toBe(2)
    const unchangedView = runtimeTasks.value.find(item => item.taskId === '1')
    expect(runtimeTasks.value[0]).not.toHaveProperty('metadata')
    const notify = vi.fn(), stop = watch(taskRecords, notify, { flush: 'sync' })
    const clone = vi.spyOn(globalThis, 'structuredClone')
    respond([task(1, 1), { ...task(2, 3), status: 'succeeded', upstreamSettled: true, metadata: { nested: { value: 200 } } }, { ...task(3, 1), status: 'succeeded', upstreamSettled: true }])
    await refreshRuntimeTasks()
    expect(notify).toHaveBeenCalledTimes(1)
    expect(clone).toHaveBeenCalledTimes(2)
    expect(taskRecords.value.map(item => item.taskId)).toEqual(['3', '2', '1'])
    expect(taskRecords.value.find(item => item.taskId === '1')).toBe(unchanged)
    expect(taskRecords.value[1].revision).toBe(3)
    expect(runtimeTaskActiveCount.value).toBe(1)
    expect(runtimeTasks.value.find(item => item.taskId === '1')).toBe(unchangedView)
    expect(runtimeTasks.value.find(item => item.taskId === '2')?.status).toBe('succeeded')
    expect(clone).toHaveBeenCalledTimes(4)
    stop()
  })

  it('keeps response, stored state and caller snapshots detached', async () => {
    const response = task(1)
    mocks.request.mockResolvedValueOnce({ result: response, runtimeEpoch: mocks.epoch })
    const returned = await getRuntimeTask('1')
    response.input.prompt = 'changed upstream response'
    returned.input.prompt = 'changed caller snapshot'
    runtimeTasks.value[0].status = 'cancelled'
    expect(taskRecords.value[0].status).toBe('running')
    expect(taskRecords.value[0]).not.toHaveProperty('input')
    expect(returned.input.prompt).toBe('changed caller snapshot')
  })

  it('rejects mixed epochs atomically and resolves pending keys even without revisions changing', async () => {
    respond([task(1)])
    await refreshRuntimeTasks()
    const original = taskRecords.value
    respond([task(2), { ...task(3), runtimeEpoch: 'foreign' }])
    await expect(refreshRuntimeTasks()).rejects.toThrow('运行时已更换')
    expect(taskRecords.value).toBe(original)
    unresolvedTaskRequests.set('fixture-input', { key: 'request-1', kind: 'generation' })
    pendingTaskRequests.value = [...unresolvedTaskRequests.values()]
    respond([task(1)])
    await refreshRuntimeTasks()
    expect(unresolvedTaskRequests.size).toBe(0)
    expect(pendingTaskRequests.value).toEqual([])
    expect(taskRecords.value).toBe(original)
  })
})


describe('runtime task pagination', () => {
  it('does not replace a newer successful refresh with an older read error', async () => {
    let fail!: (error: Error) => void
    mocks.request.mockImplementationOnce(() => new Promise((_, reject) => { fail = reject }))
    const earlier = refreshRuntimeTasks()
    respond([task(2, 2)], null, 2)
    await refreshRuntimeTasks()
    const current = taskRecords.value
    expect(runtimeTaskError.value).toBe('')
    fail(new Error('late poll failure'))
    await expect(earlier).rejects.toThrow('late poll failure')
    expect(runtimeTaskError.value).toBe('')
    expect(taskRecords.value).toBe(current)
    expect(taskRecords.value.map(item => item.taskId)).toEqual(['2'])
  })

  it('collects all pages atomically and polls only revisions after the complete snapshot', async () => {
    respond([task(3, 3)], 3, 3)
    respond([task(2, 2), task(1, 1)], null, 3)
    const notify = vi.fn(), stop = watch(taskRecords, notify, { flush: 'sync' })
    await refreshRuntimeTasks()
    expect(taskRecords.value.map(item => item.taskId)).toEqual(['3', '2', '1'])
    expect(notify).toHaveBeenCalledTimes(1)
    expect(mocks.request.mock.calls[1][0]).toContain('before=3')
    expect(mocks.request.mock.calls[1][0]).toContain('throughRevision=3')
    respond([], null, 3)
    await refreshRuntimeTasks()
    expect(mocks.request.mock.calls[2][0]).toContain('afterRevision=3')
    expect(taskRecords.value).toHaveLength(3)
    stop()
  })

  it('does not publish or advance the cursor when a later page fails', async () => {
    respond([task(3, 3)], 3, 3)
    mocks.request.mockRejectedValueOnce(new Error('connection lost'))
    await expect(refreshRuntimeTasks()).rejects.toThrow('connection lost')
    expect(runtimeTaskError.value).toBe('connection lost')
    expect(taskRecords.value).toEqual([])
    respond([task(3, 3), task(2, 2)], null, 3)
    await refreshRuntimeTasks()
    expect(mocks.request.mock.calls[2][0]).toContain('afterRevision=0')
    expect(taskRecords.value).toHaveLength(2)
  })

  it('restarts from zero after an epoch change', async () => {
    respond([task(1, 2)], null, 2)
    await refreshRuntimeTasks()
    mocks.epoch += '-reopened'
    respond([task(1, 2)], null, 2)
    await refreshRuntimeTasks()
    expect(mocks.request.mock.calls[1][0]).toContain('afterRevision=0')
    expect(taskRecords.value[0].runtimeEpoch).toBe(mocks.epoch)
  })

  it('does not publish a batch cancelled during its final page', async () => {
    const controller = new AbortController()
    respond([task(3, 3)], 3, 3)
    mocks.request.mockImplementationOnce(async () => {
      controller.abort()
      return { result: { items: [task(2, 2)], nextCursor: null, throughRevision: 3 }, runtimeEpoch: mocks.epoch }
    })
    await expect(refreshRuntimeTasks(controller.signal)).rejects.toThrow()
    expect(taskRecords.value).toEqual([])
    respond([task(3, 3)], null, 3)
    await refreshRuntimeTasks()
    expect(mocks.request.mock.calls[2][0]).toContain('afterRevision=0')
  })

  it('rejects an epoch change between pages without mixing workspaces', async () => {
    respond([task(3, 3)], 3, 3)
    mocks.request.mockImplementationOnce(async () => {
      mocks.epoch += '-changed'
      return { result: { items: [task(2, 2)], nextCursor: null, throughRevision: 3 }, runtimeEpoch: mocks.epoch }
    })
    await expect(refreshRuntimeTasks()).rejects.toThrow('运行时连接已更换')
    expect(taskRecords.value).toEqual([])
    respond([task(1, 1)], null, 1)
    await refreshRuntimeTasks()
    expect(mocks.request.mock.calls[2][0]).toContain('afterRevision=0')
    expect(taskRecords.value.map(item => item.taskId)).toEqual(['1'])
  })
})
