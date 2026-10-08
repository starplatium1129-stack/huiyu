import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import RuntimeTaskResult from './RuntimeTaskResult.vue'
import type { TaskRecord } from '../../../types/tasks'

const api = vi.hoisted(() => ({ fetch: vi.fn(), archive: vi.fn(), download: vi.fn() }))
vi.mock('@/api/runtimeTasks', () => ({
  fetchRuntimeResult: api.fetch, markRuntimeTask: vi.fn(), downloadTaskMedia: api.download,
  runtimeResultPath: (task: TaskRecord, index: number) => `/fixture/${task.taskId}/${index}`,
}))
vi.mock('@/composables/tasks/taskArtwork', () => ({ archiveTaskResult: api.archive }))
vi.mock('@/utils/runtimeEnvironment', () => ({ isLocalStudioHost: () => true }))
const task: TaskRecord = {
  taskId: 'fixture', requestKey: 'fixture', kind: 'anima', status: 'succeeded',
  workspaceId: 'fixture', principalId: 'owner', requestFingerprint: 'fixture', provider: 'comfy', providerFingerprint: 'fixture',
  upstreamId: 'fixture', revision: 1, runtimeEpoch: 'fixture', createdAt: 1, updatedAt: 1, submissionIntentAt: 1,
  submissionObservedAt: 1, cancelRequestedAt: null, executionDeadline: 9999999999999, inputMediaRefs: [],
  recoveryState: 'normal', upstreamSettled: true, metadata: {}, input: { prompt: 'fixture' },
  resultState: 'available', deliveryState: 'seen',
  resultRefs: [0, 1].map(index => ({ index, mime: 'image/png', alias: `image-${index}`, sha256: 'a'.repeat(64), bytes: 64 })),
  errorCode: null, checkpoint: null, parentBatchId: null, stepIndex: null,
}
beforeEach(() => {
  vi.resetAllMocks()
  api.fetch.mockResolvedValue(new Blob(['fixture'], { type: 'image/png' }))
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fixture')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
})

it('does not attach a late video download error to a replacement output', async () => {
  let reject!: (error: Error) => void
  api.download.mockReturnValueOnce(new Promise<void>((_done, fail) => { reject = fail }))
  const videoTask = { ...task, resultRefs: task.resultRefs.map(output => ({ ...output, mime: 'video/mp4' })) }
  const wrapper = mount(RuntimeTaskResult, { props: { task: videoTask }, global: {
    stubs: { StudioSelect: true, StudioMediaPlayer: true }, directives: { 'content-motion': {} },
  } })
  try {
    await wrapper.get('button.btn-ghost').trigger('click')
    expect(api.download).toHaveBeenCalledWith('/fixture/fixture/0', '绘遇-fixture-0.mp4')
    wrapper.getComponent({ name: 'StudioSelect' }).vm.$emit('update:model-value', 1)
    await flushPromises()
    reject(new Error('first video download failed'))
    await flushPromises()
    expect(wrapper.text()).not.toContain('first video download failed')
    api.download.mockRejectedValueOnce(new Error('current video download failed'))
    await wrapper.get('button.btn-ghost').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('current video download failed')
  } finally { wrapper.unmount() }
})
afterEach(() => vi.restoreAllMocks())

it.each(['success', 'failure'])('keeps a late save %s attached to the selected output that started it', async outcome => {
  let resolve!: () => void, reject!: (error: Error) => void
  api.archive.mockReturnValueOnce(new Promise<void>((done, fail) => { resolve = done; reject = fail }))
  const wrapper = mount(RuntimeTaskResult, { props: { task }, global: {
    stubs: { StudioSelect: true, StudioMediaPlayer: true }, directives: { 'content-motion': {} },
  } })
  try {
    await flushPromises()
    await wrapper.get('button.btn-primary').trigger('click')
    expect(api.archive).toHaveBeenCalledWith('fixture', 0)
    wrapper.getComponent({ name: 'StudioSelect' }).vm.$emit('update:model-value', 1)
    await flushPromises()
    if (outcome === 'success') resolve()
    else reject(new Error('first output save failed'))
    await flushPromises()
    expect(wrapper.text()).not.toContain('已保存到作品册。')
    expect(wrapper.text()).not.toContain('first output save failed')
    expect(wrapper.find('img').exists()).toBe(true)
    expect(wrapper.get('button.btn-primary').attributes('disabled')).toBeUndefined()
    await wrapper.get('button.btn-primary').trigger('click')
    await flushPromises()
    expect(api.archive).toHaveBeenLastCalledWith('fixture', 1)
    expect(wrapper.text()).toContain('已保存到作品册。')
  } finally { wrapper.unmount() }
})
