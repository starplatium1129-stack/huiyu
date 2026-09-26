import { beforeEach, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'

const mocks = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), query: vi.fn(), cancel: vi.fn() }))
vi.mock('@/platform/web/taskHistory', () => ({ readTaskHistory: mocks.get, updateTaskHistory: async (update: (value: unknown) => unknown) => { const value = update(await mocks.get()); await mocks.set('tasks', value); return value } }))
vi.mock('./taskRecovery', () => ({ queryTask: mocks.query, cancelRecoveredTask: mocks.cancel }))
const saved = { id: 'old', title: '视频', kind: 'video', status: 'running', route: '/video-studio?job=one', createdAt: 1, updatedAt: 1, backend: { kind: 'video', id: 'one' } }
beforeEach(() => {
  vi.resetModules()
  Object.values(mocks).forEach(fn => fn.mockReset())
  mocks.get.mockResolvedValue([saved]); mocks.set.mockResolvedValue(undefined)
})
async function setup() {
  const center = await import('@/composables/useTaskCenter')
  const { useTaskRecovery } = await import('./useTaskRecovery')
  let recovery!: ReturnType<typeof useTaskRecovery>
  const owner = mount(defineComponent({ setup() { recovery = useTaskRecovery(); return () => h('div') } }))
  return { center, recovery, owner }
}
it('temporary query failure is retryable and does not fabricate a terminal state', async () => {
  const { center, recovery, owner } = await setup()
  mocks.query.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ status: 'succeeded' })
  await recovery.refresh()
  expect(center.useTaskCenter().tasks.value[0].status).toBe('interrupted')
  expect(recovery.error.value).toContain('重试')
  await recovery.refresh()
  expect(center.useTaskCenter().tasks.value[0].status).toBe('succeeded')
  expect(recovery.error.value).toBe('')
  owner.unmount(); await center.flushTaskSummaries()
})
it('late query results cannot overwrite newer state', async () => {
  const { center, recovery, owner } = await setup()
  let resolve!: (patch: { status: string }) => void
  mocks.query.mockImplementation(() => new Promise(done => { resolve = done }))
  await center.hydrateTasks()
  const request = recovery.refresh(); await Promise.resolve()
  center.updateTask('old', { status: 'cancelled' })
  resolve({ status: 'running' }); await request
  expect(center.useTaskCenter().tasks.value[0].status).toBe('cancelled')
  owner.unmount(); await center.flushTaskSummaries()
})
it('unmount aborts the query and ignores its late reply', async () => {
  const { center, recovery, owner } = await setup()
  let resolve!: (patch: { status: string }) => void
  mocks.query.mockImplementation(() => new Promise(done => { resolve = done }))
  await center.hydrateTasks()
  const request = recovery.refresh(); await Promise.resolve()
  const signal = mocks.query.mock.calls[0][1] as AbortSignal
  owner.unmount(); expect(signal.aborted).toBe(true)
  resolve({ status: 'succeeded' }); await request
  expect(center.useTaskCenter().tasks.value[0].status).toBe('interrupted')
})
it('cancel is confirmed by a fresh query, never by the request alone', async () => {
  const { center, recovery, owner } = await setup()
  await center.hydrateTasks()
  mocks.cancel.mockResolvedValue(undefined)
  mocks.query.mockResolvedValue({ status: 'running', message: '取消中' })
  await recovery.cancel('old')
  expect(center.useTaskCenter().tasks.value[0].status).toBe('running')
  mocks.query.mockResolvedValue({ status: 'cancelled' })
  await recovery.refresh()
  expect(center.useTaskCenter().tasks.value[0].status).toBe('cancelled')
  owner.unmount(); await center.flushTaskSummaries()
})
