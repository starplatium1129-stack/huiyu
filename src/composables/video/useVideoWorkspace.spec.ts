import { defineComponent, h, KeepAlive, ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useVideoWorkspace } from './useVideoWorkspace'
import type { VideoFramesDeps } from '@/components/video/useVideoFrames'

const mocks = vi.hoisted(() => ({ create: vi.fn(), frames: vi.fn(), record: vi.fn(), fetch: vi.fn(), status: vi.fn() }))
vi.mock('vue-router', () => ({ useRoute: () => ({ path: '/video-studio', query: {} }), useRouter: () => ({ replace: vi.fn() }) }))
vi.mock('@/composables/useTaskCenter', () => ({ useTrackedTask: vi.fn() }))
vi.mock('@/composables/tasks/useBackendSelection', () => ({ useBackendSelection: () => ({ retry: vi.fn() }) }))
vi.mock('@/stores/videoStore', () => ({ useVideoStore: () => ({ recordVideoTask: mocks.record }) }))
vi.mock('@/api/videoApi', () => ({
  createVideoJob: mocks.create, fetchVideoJob: mocks.fetch, cancelVideoJob: vi.fn(),
  fetchVideoStatus: mocks.status,
}))
vi.mock('@/components/video/useVideoFrames', () => ({ useVideoFrames: (deps: VideoFramesDeps) => {
  deps.videoImageId.value = 'restored-first'
  deps.lastFrameImageId.value = 'restored-last'
  return {
  resolveSubmitFrames: mocks.frames, consumeVideoCtx: vi.fn(), disposeFrames: vi.fn(),
} } }))
vi.mock('@/components/video/useVideoStudioDraft', () => ({ useVideoStudioDraft: () => ({
  startDraftWatch: () => vi.fn(), restoreDraft: async () => ({}), reconnectTask: async () => ({ kind: 'none' }),
}) }))

let wrapper: ReturnType<typeof mount> | undefined
async function setup() {
  let workspace!: ReturnType<typeof useVideoWorkspace>
  wrapper = mount(defineComponent({ setup() { workspace = useVideoWorkspace(); return () => null } }))
  await flushPromises()
  workspace.prompt.value = 'A calm afternoon by the window'
  return workspace
}
beforeEach(() => {
  mocks.status.mockResolvedValue({ online: true, models: [{ id: 'minimax-h3', available: true, executable: true, modes: ['text', 'image', 'first-last-frame'] }], defaults: { modelId: 'minimax-h3' } })
})
afterEach(() => { wrapper?.unmount(); vi.clearAllMocks(); vi.useRealTimers() })
describe('video submission recovery', () => {
  it('distinguishes offline draft editing from models awaiting installation', async () => {
    const workspace = await setup()
    expect(workspace.modeBadge('image')).toBe('可生成')
    workspace.status.value!.online = false
    expect(workspace.modeBadge('image')).toBe('离线 · 可编辑')
    expect(workspace.modeReady('image')).toBe(true)
    expect(workspace.canGenerate.value).toBe(false)
    workspace.status.value!.models[0].available = false
    expect(workspace.modeBadge('image')).toBe('待装权重 · 可编辑')
    expect(workspace.modeBadge('shots')).toBe('待装权重')
  })
  it('submits the settings captured before asynchronous frame preparation', async () => {
    let resolve!: (frames: object) => void
    mocks.frames.mockReturnValueOnce(new Promise(done => { resolve = done }))
    mocks.create.mockResolvedValueOnce({ job: { id: 'one', status: 'succeeded' } })
    const workspace = await setup()
    const pending = workspace.submitVideo()
    workspace.prompt.value = 'Changed while preparing'
    workspace.duration.value = 15
    workspace.selectedMode.value = 'shots'
    resolve({})
    await pending
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'A calm afternoon by the window', duration: 3 }))
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ mode: 'text' }))
  })
  it('reports when an accepted video job cannot be recorded for reconnect', async () => {
    mocks.frames.mockResolvedValueOnce({})
    mocks.create.mockResolvedValueOnce({ job: { id: 'unrecorded', status: 'succeeded' } })
    mocks.record.mockReturnValueOnce(false)
    const workspace = await setup()
    await workspace.submitVideo()
    expect(workspace.statusError.value).toContain('任务记录保存失败')
  })
  it('keeps the submission failure visible after refreshing environment status', async () => {
    mocks.frames.mockResolvedValueOnce({})
    mocks.create.mockRejectedValueOnce(new Error('测试提交失败'))
    const workspace = await setup()
    await workspace.submitVideo()
    expect(workspace.statusError.value).toContain('测试提交失败')
    expect(workspace.canGenerate.value).toBe(true)
  })
  it('disables submission while frame preparation is still running', async () => {
    const workspace = await setup()
    expect(workspace.canGenerate.value).toBe(true)
    workspace.uploadingImage.value = true
    expect(workspace.canGenerate.value).toBe(false)
  })
  it('allows first-last-frame drafts restored from local IDs without server filenames', async () => {
    const workspace = await setup()
    workspace.selectedMode.value = 'first-last-frame'
    expect(workspace.canGenerate.value).toBe(true)
  })
  it('does not clear a newer upload when an earlier submission finishes', async () => {
    let resolve!: (value: object) => void
    mocks.frames.mockResolvedValueOnce({})
    mocks.create.mockReturnValueOnce(new Promise(done => { resolve = done }))
    const workspace = await setup()
    const pending = workspace.submitVideo()
    await flushPromises()
    workspace.uploadingImage.value = true
    resolve({ job: { id: 'old', status: 'succeeded' } })
    await pending
    expect(workspace.uploadingImage.value).toBe(true)
  })
  it('keeps the latest environment check when an earlier reply arrives late', async () => {
    const workspace = await setup()
    const initial = workspace.status.value!
    let first!: (value: unknown) => void, second!: (value: unknown) => void
    mocks.status.mockReturnValueOnce(new Promise(resolve => { first = resolve }))
      .mockReturnValueOnce(new Promise(resolve => { second = resolve }))
    const older = workspace.loadStatus()
    const oldSignal = mocks.status.mock.calls[1][0] as AbortSignal
    const newer = workspace.loadStatus()
    expect(oldSignal.aborted).toBe(true)
    second({ ...initial, online: false })
    await newer
    first(initial)
    await older
    expect(workspace.status.value?.online).toBe(false)
    expect(workspace.statusLoading.value).toBe(false)
  })
  it('stops reading a cached page task and resumes without cancelling its backend job', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const visible = ref(true)
    let workspace!: ReturnType<typeof useVideoWorkspace>
    const page = defineComponent({ setup() { workspace = useVideoWorkspace(); return () => null } })
    wrapper = mount(defineComponent({ setup: () => () => h(KeepAlive, null, { default: () => visible.value ? h(page) : null }) }))
    await flushPromises()
    workspace.prompt.value = 'A calm afternoon by the window'
    mocks.frames.mockResolvedValueOnce({})
    mocks.create.mockResolvedValueOnce({ job: { id: 'running', status: 'running' } })
    let finish!: (value: object) => void
    mocks.fetch.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    await workspace.submitVideo()
    await vi.advanceTimersByTimeAsync(1500)
    expect(mocks.fetch).toHaveBeenCalledOnce()
    const signal = mocks.fetch.mock.calls[0][1] as AbortSignal
    visible.value = false
    await flushPromises()
    expect(signal.aborted).toBe(true)
    finish({ job: { id: 'running', status: 'succeeded' } })
    await flushPromises()
    await vi.advanceTimersByTimeAsync(4500)
    expect(mocks.fetch).toHaveBeenCalledOnce()
    expect(workspace.job.value?.status).toBe('running')
    mocks.fetch.mockResolvedValueOnce({ job: { id: 'running', status: 'succeeded' } })
    visible.value = true
    await flushPromises()
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
    expect(workspace.job.value?.status).toBe('succeeded')
  })
})
