import { beforeEach, expect, it, vi } from 'vitest'
import { defineComponent, h, KeepAlive, nextTick, ref } from 'vue'
import { mount } from '@vue/test-utils'

const storage = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }))
vi.mock('@/platform/web/taskHistory', () => ({ readTaskHistory: storage.get, updateTaskHistory: async (update: (value: unknown) => unknown) => { const value = JSON.parse(JSON.stringify(update(await storage.get('tasks')))); await storage.set('tasks', value); return value } }))
beforeEach(() => { vi.resetModules(); storage.get.mockReset().mockResolvedValue([]); storage.set.mockReset().mockResolvedValue(undefined) })

it('a delayed initial read cannot revive a task cleared while hydration was pending', async () => {
  const module = await import('./useTaskCenter')
  module.createTask({ kind: 'image', title: '已完成', status: 'succeeded', route: '/gallery' })
  await module.flushTaskSummaries()
  const stale = structuredClone(storage.set.mock.calls.at(-1)![1])
  let finish!: (value: unknown) => void
  storage.get.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const hydration = module.hydrateTasks()
  module.useTaskCenter().clearCompleted()
  await module.flushTaskSummaries()
  finish(stale)
  await hydration
  expect(module.useTaskCenter().tasks.value).toEqual([])
})

it('a failed read can be retried and never overwrites unseen history', async () => {
  storage.get.mockRejectedValueOnce(new Error('unavailable'))
  const module = await import('./useTaskCenter')
  module.createTask({ kind: 'image', title: '新任务', status: 'running', route: '/prompt-builder' })
  await module.flushTaskSummaries()
  expect(storage.set).not.toHaveBeenCalled()
  storage.get.mockResolvedValue([{ id: 'old', kind: 'image', title: '旧任务', status: 'succeeded', route: '/gallery', createdAt: 1 }])
  await module.hydrateTasks()
  expect(module.useTaskCenter().tasks.value.map(task => task.title)).toContain('旧任务')
  expect(module.useTaskCenter().storageError.value).toBe('')
})

it('reconnecting a finished backend job updates its existing history record', async () => {
  storage.get.mockResolvedValue([{ id: 'old', kind: 'video', title: '视频', status: 'running', route: '/video-studio', backend: { kind: 'video', id: 'job-1' }, createdAt: 1 }])
  const module = await import('./useTaskCenter')
  await module.hydrateTasks()
  const owner = mount(defineComponent({ setup() {
    module.useTrackedTask(() => ({ kind: 'video', title: '视频', status: 'succeeded', route: '/video-studio', backend: { kind: 'video', id: 'job-1' } }))
    return () => h('div')
  } }))
  expect(module.useTaskCenter().tasks.value).toHaveLength(1)
  expect(module.useTaskCenter().tasks.value[0]).toMatchObject({ id: 'old', status: 'succeeded' })
  owner.unmount(); await module.flushTaskSummaries()
})

it('invalid persisted status and backend paths cannot become actionable jobs', async () => {
  storage.get.mockResolvedValue([
    { id: 'bad', kind: 'video', title: 'bad', status: 'invented', route: '/video-studio' },
    { id: 'path', kind: 'video', title: 'path', status: 'running', route: '/video-studio', backend: { kind: 'video', id: '../control' } },
  ])
  const module = await import('./useTaskCenter')
  await module.hydrateTasks()
  expect(module.useTaskCenter().tasks.value).toHaveLength(1)
  expect(module.useTaskCenter().tasks.value[0].backend).toBeUndefined()
})

it('switching backend identities preserves the previous running task', async () => {
  const module = await import('./useTaskCenter')
  const backendId = ref('one')
  const owner = mount(defineComponent({ setup() {
    module.useTrackedTask(() => ({ kind: 'video', title: '视频', status: 'running', route: '/video-studio', backend: { kind: 'video', id: backendId.value } }))
    return () => h('div')
  } }))
  backendId.value = 'two'; await nextTick()
  const records = module.useTaskCenter().tasks.value
  expect(records.map(task => task.backend?.id).sort()).toEqual(['one', 'two'])
  expect(module.useTaskCenter().controls(records.find(task => task.backend?.id === 'one')!.id)).toBeUndefined()
  owner.unmount(); await module.flushTaskSummaries()
})

it('new tasks merge with restored summaries and old running work is not reported as live', async () => {
  storage.get.mockResolvedValue([{ id: 'previous', kind: 'batch', title: '旧批次', status: 'running', route: '/prompt-builder', createdAt: 1, updatedAt: 1 }])
  const module = await import('./useTaskCenter')
  module.createTask({ kind: 'image', title: '新任务', status: 'running', route: '/prompt-builder' })
  await module.flushTaskSummaries()
  expect(module.useTaskCenter().tasks.value).toHaveLength(2)
  expect(module.useTaskCenter().tasks.value.find(task => task.id === 'previous')?.status).toBe('interrupted')
  expect(module.useTaskCenter().activeCount.value).toBe(1)
  expect(storage.set.mock.calls.at(-1)?.[1]).toMatchObject({ version: 1, records: expect.any(Array) })
  expect(storage.set.mock.calls.at(-1)?.[1].records).toHaveLength(2)
})

it('merges stale window writes and persists deletion tombstones', async () => {
  let persisted: unknown = []
  storage.get.mockImplementation(async () => structuredClone(persisted))
  storage.set.mockImplementation(async (_key: string, value: unknown) => { persisted = structuredClone(value) })

  const first = await import('./useTaskCenter')
  first.createTask({ kind: 'image', title: '窗口 A', status: 'running', route: '/prompt-builder' })
  await first.flushTaskSummaries()

  vi.resetModules()
  const second = await import('./useTaskCenter')
  second.createTask({ kind: 'image', title: '窗口 B', status: 'succeeded', route: '/gallery' })
  await second.flushTaskSummaries()
  expect((persisted as { records: unknown[] }).records).toHaveLength(2)

  first.updateTask(first.useTaskCenter().tasks.value.find(task => task.title === '窗口 A')!.id, { message: 'A 的更新' })
  await first.flushTaskSummaries()
  expect((persisted as { records: Array<{ title: string }> }).records.map(task => task.title).sort()).toEqual(['窗口 A', '窗口 B'])

  second.useTaskCenter().clearCompleted()
  await second.flushTaskSummaries()
  vi.resetModules()
  const restored = await import('./useTaskCenter')
  await restored.hydrateTasks()
  expect(restored.useTaskCenter().tasks.value.map(task => task.title)).toEqual(['窗口 A'])
})

it('deactivation retains work and controls; true destruction marks it interrupted', async () => {
  const module = await import('./useTaskCenter')
  const show = ref(true), progress = ref(10), cancel = vi.fn()
  const Owner = defineComponent({ name: 'Owner', setup() { module.useTrackedTask(() => ({ kind: 'batch', title: '批次', status: 'running', route: '/prompt-builder', progress: progress.value }), { cancel }); return () => h('div') } })
  const wrapper = mount(defineComponent({ setup: () => () => h(KeepAlive, null, { default: () => show.value ? h(Owner) : null }) }))
  show.value = false; await nextTick(); progress.value = 40; await nextTick()
  const task = module.useTaskCenter().tasks.value[0]
  expect(task.progress).toBe(40)
  expect(task.status).toBe('running')
  module.useTaskCenter().controls(task.id)?.cancel?.()
  expect(cancel).toHaveBeenCalledOnce()
  wrapper.unmount()
  expect(module.useTaskCenter().tasks.value[0].status).toBe('interrupted')
  expect(module.useTaskCenter().controls(task.id)).toBeUndefined()
  await module.flushTaskSummaries()
})

it('clearing history preserves active work and failures', async () => {
  const module = await import('./useTaskCenter')
  for (const status of ['running', 'failed', 'succeeded'] as const) module.createTask({ kind: 'image', title: status, status, route: '/prompt-builder' })
  module.useTaskCenter().clearCompleted()
  expect(module.useTaskCenter().tasks.value.map(task => task.status).sort()).toEqual(['failed', 'running'])
  await module.flushTaskSummaries()
})

it('persistence failure is visible without marking the running task failed', async () => {
  storage.set.mockRejectedValue(new Error('quota'))
  const module = await import('./useTaskCenter')
  module.createTask({ kind: 'image', title: '绘图', status: 'running', route: '/prompt-builder' })
  await module.flushTaskSummaries()
  expect(module.useTaskCenter().storageError.value).toContain('暂未保存')
  expect(module.useTaskCenter().activeCount.value).toBe(1)
})


it('a stopped owner can register a retry after its summary was cleared', async () => {
  const module = await import('./useTaskCenter')
  const status = ref<'running' | 'cancelled'>('running')
  const owner = mount(defineComponent({ setup() { module.useTrackedTask(() => ({ kind: 'batch', title: '重试批次', status: status.value, route: '/prompt-builder' })); return () => h('div') } }))
  status.value = 'cancelled'; await nextTick()
  module.useTaskCenter().clearCompleted()
  expect(module.useTaskCenter().tasks.value).toHaveLength(0)
  status.value = 'running'; await nextTick()
  expect(module.useTaskCenter().activeCount.value).toBe(1)
  owner.unmount(); await module.flushTaskSummaries()
})

it.each(['failed', 'cancelled'] as const)('a retry retains the previous %s summary', async terminal => {
  const module = await import('./useTaskCenter')
  const status = ref<'running' | 'failed' | 'cancelled'>('running')
  const owner = mount(defineComponent({ setup() { module.useTrackedTask(() => ({ kind: 'image', title: '绘图', status: status.value, route: '/prompt-builder' })); return () => h('div') } }))
  const first = module.useTaskCenter().tasks.value[0].id
  status.value = terminal; await nextTick()
  status.value = 'running'; await nextTick()
  const tasks = module.useTaskCenter().tasks.value
  expect(tasks).toHaveLength(2)
  expect(tasks.find(task => task.id === first)?.status).toBe(terminal)
  expect(module.useTaskCenter().activeCount.value).toBe(1)
  owner.unmount(); await module.flushTaskSummaries()
})

it('a late stale-window update cannot resurrect a deleted ID even with a newer timestamp', async () => {
  let persisted: unknown = []
  storage.get.mockImplementation(async () => structuredClone(persisted))
  storage.set.mockImplementation(async (_key: string, value: unknown) => { persisted = structuredClone(value) })
  const a = await import('./useTaskCenter')
  const id = a.createTask({ kind: 'image', title: 'old', status: 'succeeded', route: '/gallery' })
  await a.flushTaskSummaries()
  vi.resetModules()
  const b = await import('./useTaskCenter')
  await b.hydrateTasks()
  b.useTaskCenter().clearCompleted()
  await b.flushTaskSummaries()
  a.updateTask(id, { message: 'late' })
  await a.flushTaskSummaries()
  expect((persisted as { records: unknown[] }).records).toHaveLength(0)
})

it('compaction requires a confirmed cross-window watermark', async () => {
  const module = await import('./useTaskCenter')
  const deleted = { old: 10, recent: 30 }
  const blocked = module.planTaskSummaryCompaction(deleted)
  expect(blocked).toMatchObject({ eligibleIds: [], retainedIds: ['old', 'recent'], safeToApply: false })
  const plan = module.planTaskSummaryCompaction(deleted, { watermark: 20, staleWritersDrained: true })
  expect(plan).toMatchObject({ eligibleIds: ['old'], retainedIds: ['recent'], safeToApply: true })
})

it('history retention remains bounded after merging persisted history', async () => {
  let persisted: unknown = []
  storage.get.mockImplementation(async () => structuredClone(persisted))
  storage.set.mockImplementation(async (_key: string, value: unknown) => { persisted = structuredClone(value) })
  const a = await import('./useTaskCenter')
  for (let i = 0; i < 65; i++) {
    a.createTask({ kind: 'image', title: String(i), status: 'succeeded', route: '/gallery' })
    await a.flushTaskSummaries()
  }
  expect((persisted as { records: unknown[] }).records).toHaveLength(60)
  expect(a.useTaskCenter().tasks.value).toHaveLength(60)
  const diagnostics = a.useTaskCenter().storageDiagnostics.value
  expect(diagnostics).toMatchObject({ recordCount: 60, tombstoneCount: 5, historyLimit: 60, compaction: { policy: 'retain-tombstones', safeToDrop: false } })
  expect(diagnostics.serializedBytes).toBeGreaterThan(0)
})
