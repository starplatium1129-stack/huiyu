import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import RuntimeTaskList from './RuntimeTaskList.vue'
import { pendingTaskRequests, taskRecords } from '@/stores/runtimeTaskState'
import type { TaskRecord } from '../../../types/tasks'

const api = vi.hoisted(() => ({ refresh: vi.fn(), cancel: vi.fn(), cancelKey: vi.fn(), act: vi.fn() }))
vi.mock('@/api/runtimeTasks', () => ({
  refreshRuntimeTasks: api.refresh, cancelRuntimeTask: api.cancel, cancelRuntimeTaskKey: api.cancelKey,
  actOnRuntimeTask: api.act, confirmWebuiTaskStopped: vi.fn(), markRuntimeTask: vi.fn(), taskMessage: () => 'fixture',
}))
vi.mock('./RuntimeTaskResult.vue', () => ({ __esModule: true, default: { template: '<div>synthetic result</div>' } }))

const task = (id: string, complete = false): TaskRecord => ({
  taskId: id, requestKey: `key-${id}`, kind: 'anima', status: complete ? 'succeeded' : 'running',
  workspaceId: 'fixture', principalId: 'owner', requestFingerprint: id, provider: 'comfy', providerFingerprint: 'fixture',
  upstreamId: id, revision: 1, runtimeEpoch: 'fixture', createdAt: 1, updatedAt: 1, submissionIntentAt: 1,
  submissionObservedAt: 1, cancelRequestedAt: null, executionDeadline: 9999999999999, inputMediaRefs: [],
  recoveryState: 'normal', upstreamSettled: complete, metadata: { width: 832, height: 1216 }, input: { prompt: 'fixture' },
  resultState: complete ? 'available' : 'none', deliveryState: 'unseen',
  resultRefs: complete ? [{ index: 0, mime: 'image/png', alias: 'completed-image', sha256: 'a'.repeat(64), bytes: 64 }] : [],
  errorCode: null, checkpoint: null, parentBatchId: null, stepIndex: null,
})
function setup() {
  return mount(RuntimeTaskList, { props: { active: true }, global: { stubs: { RouterLink: true }, directives: { 'content-motion': {} } } })
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
beforeEach(() => {
  vi.resetAllMocks()
  taskRecords.value = [task('active'), task('complete', true)]
  pendingTaskRequests.value = []
})
afterEach(() => { taskRecords.value = []; pendingTaskRequests.value = [] })

it('releases result previews when the panel closes and retains its selected inbox on reopening', async () => {
  const wrapper = setup()
  const button = (label: string) => wrapper.findAll('button').find(item => item.text() === label)!
  try {
    await button('结果收件箱').trigger('click')
    await button('查看结果').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('synthetic result')
    await wrapper.setProps({ active: false })
    expect(wrapper.text()).not.toContain('synthetic result')
    expect(api.cancel).not.toHaveBeenCalled()
    expect(taskRecords.value[1].resultRefs).toHaveLength(1)
    await wrapper.setProps({ active: true })
    await flushPromises()
    expect(button('结果收件箱').attributes('aria-pressed')).toBe('true')
    expect(wrapper.text()).toContain('synthetic result')
  } finally { wrapper.unmount() }
})

it('refresh cannot release an in-flight task cancellation and permit a second command', async () => {
  const pending = deferred()
  api.cancel.mockReturnValue(pending.promise)
  const wrapper = setup()
  const button = (label: string) => wrapper.findAll('button').find(item => item.text() === label)!
  try {
    await button('查看结果').trigger('click')
    await flushPromises()
    await button('取消任务').trigger('click')
    await button('更新状态').trigger('click')
    await flushPromises()
    await button('取消任务').trigger('click')
    expect(api.cancel).toHaveBeenCalledTimes(1)
    expect(api.refresh).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('synthetic result')
    expect(taskRecords.value[1].resultRefs).toHaveLength(1)
    pending.resolve(); await flushPromises()
    await button('更新状态').trigger('click')
    expect(api.refresh).toHaveBeenCalledOnce()
  } finally { pending.resolve(); wrapper.unmount() }
})

it('unknown acceptance cancellation is single-flight and can be retried after a failed response', async () => {
  pendingTaskRequests.value = [{ key: 'original-key', kind: 'anima' }]
  const pending = deferred()
  api.cancelKey.mockImplementationOnce(async () => { await pending.promise; throw new Error('receipt lost') })
  const wrapper = setup()
  const button = () => wrapper.findAll('button').find(item => item.text() === '取消这次提交')!
  try {
    await button().trigger('click')
    await button().trigger('click')
    expect(api.cancelKey).toHaveBeenCalledTimes(1)
    pending.resolve(); await flushPromises()
    expect(wrapper.text()).toContain('取消尚未确认')
    expect(pendingTaskRequests.value[0].key).toBe('original-key')
    await button().trigger('click'); await flushPromises()
    expect(api.cancelKey.mock.calls).toEqual([['original-key'], ['original-key']])
  } finally { pending.resolve(); wrapper.unmount() }
})

it('routes an independent shot retry back to its source batch while leaving results in its own inbox', () => {
  taskRecords.value = [{ ...task('independent', true), kind: 'batch', metadata: { context: { retriedTaskId: 'original/batch', stepIndex: 2 } } }]
  const wrapper = setup()
  try {
    expect(wrapper.get('router-link-stub').attributes('to')).toBe('/video-studio?mode=shots&batch=original%2Fbatch')
    expect(taskRecords.value[0].taskId).toBe('independent')
    expect(taskRecords.value[0].resultRefs).toHaveLength(1)
  } finally { wrapper.unmount() }
})
