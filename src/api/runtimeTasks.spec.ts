import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { watch } from 'vue'
import type { TaskRecord } from '../../types/tasks'

const mocks = vi.hoisted(() => ({ request: vi.fn(), epoch: 'one' }))
vi.mock('./client', () => ({ apiClient: { request: mocks.request }, ApiClientError: class extends Error {} }))
vi.mock('../platform/desktop/runtime.ts', () => ({
  getDesktopRuntime: () => ({ connection: 'ready', bootstrap: { runtime: { workspace: {
    runtimeEpoch: mocks.epoch, workspaceId: 'fixture', domains: ['artwork'],
  } } } }),
  desktopRuntimeFetch: vi.fn(), onDesktopRuntime: vi.fn(),
}))
import { refreshRuntimeTasks, getRuntimeTask } from './runtimeTasks'
import { taskRecords, runtimeTasks, unresolvedTaskRequests, pendingTaskRequests } from './runtimeTaskState'

const task = (id: number, revision = 1): TaskRecord => ({
  taskId: String(id), runtimeEpoch: mocks.epoch, revision, createdAt: id,
  requestKey: `request-${id}`, status: 'running', upstreamSettled: false,
  input: { prompt: 'neutral fixture '.repeat(100) }, metadata: { nested: { value: id } }, resultRefs: [],
} as unknown as TaskRecord)
function respond(items: TaskRecord[]) {
  mocks.request.mockResolvedValueOnce({ result: { items }, runtimeEpoch: mocks.epoch })
}
beforeEach(() => {
  mocks.epoch = 'one'; mocks.request.mockReset()
  taskRecords.value = []; unresolvedTaskRequests.clear(); pendingTaskRequests.value = []
})
afterEach(() => vi.restoreAllMocks())

describe('runtime task snapshot merging', () => {
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
    const notify = vi.fn(), stop = watch(taskRecords, notify, { flush: 'sync' })
    const clone = vi.spyOn(globalThis, 'structuredClone')
    respond([task(1, 1), task(2, 3), task(3, 1)])
    await refreshRuntimeTasks()
    expect(notify).toHaveBeenCalledTimes(1)
    expect(clone).toHaveBeenCalledTimes(2)
    expect(taskRecords.value.map(item => item.taskId)).toEqual(['3', '2', '1'])
    expect(taskRecords.value.find(item => item.taskId === '1')).toBe(unchanged)
    expect(taskRecords.value[1].revision).toBe(3)
    stop()
  })

  it('keeps response, stored state and caller snapshots detached', async () => {
    const response = task(1)
    mocks.request.mockResolvedValueOnce({ result: response, runtimeEpoch: mocks.epoch })
    const returned = await getRuntimeTask('1')
    response.input.prompt = 'changed upstream response'
    returned.input.prompt = 'changed caller snapshot'
    runtimeTasks.value[0].input.prompt = 'changed view snapshot'
    expect(taskRecords.value[0].input.prompt).toBe('neutral fixture '.repeat(100))
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
