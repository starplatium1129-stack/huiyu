import { defineComponent, h, KeepAlive, ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useVideoWorkspace } from './useVideoWorkspace'
import type { VideoFramesDeps } from '@/components/video/useVideoFrames'

const mocks = vi.hoisted(() => ({ create: vi.fn(), frames: vi.fn(), record: vi.fn(), fetch: vi.fn(), status: vi.fn(), cancel: vi.fn(), realFrames: false, consume: vi.fn(), image: vi.fn(), upload: vi.fn() }))
vi.mock('@/composables/useTaskCenter', () => ({ useTrackedTask: vi.fn() }))
vi.mock('@/stores/videoStore', () => ({ useVideoStore: () => ({ recordVideoTask: mocks.record, consumeImageCtx: mocks.consume }) }))
vi.mock('@/stores/sceneStore', () => ({ useSceneStore: () => ({ sceneBlueprints: [] }) }))
vi.mock('@/storage/artworkRepository', () => ({ artworkRepository: { getImage: mocks.image } }))
vi.mock('@/api/videoApi', () => ({
  createVideoJob: mocks.create, fetchVideoJob: mocks.fetch, cancelVideoJob: mocks.cancel,
  fetchVideoStatus: mocks.status, uploadVideoImage: mocks.upload,
}))
vi.mock('@/components/video/useVideoFrames', async importOriginal => {
  const actual = await importOriginal<typeof import('@/components/video/useVideoFrames')>()
  return { useVideoFrames: (deps: VideoFramesDeps) => {
    if (mocks.realFrames) {
      deps.selectedMode.value = 'image'
      deps.prompt.value = 'An old valid shot description'
      deps.aspectRatio.value = 'landscape'
      return actual.useVideoFrames(deps)
    }
    deps.videoImageId.value = 'restored-first'
    deps.lastFrameImageId.value = 'restored-last'
    return { resolveSubmitFrames: mocks.frames, consumeVideoCtx: vi.fn(), disposeFrames: vi.fn() }
  } }
})
vi.mock('@/components/video/useVideoStudioDraft', () => ({ useVideoStudioDraft: () => ({
  startDraftWatch: () => vi.fn(), restoreDraft: async () => ({}), reconnectTask: async () => ({ kind: 'none' }),
}) }))

let wrapper: ReturnType<typeof mount> | undefined
let router: ReturnType<typeof createRouter>
async function setup(prompt: string | null = 'A calm afternoon by the window') {
  let workspace!: ReturnType<typeof useVideoWorkspace>
  wrapper = mount(defineComponent({ setup() { workspace = useVideoWorkspace(); return () => null } }), { global: { plugins: [router] } })
  await flushPromises()
  if (prompt !== null) workspace.prompt.value = prompt
  return workspace
}
beforeEach(async () => {
  mocks.realFrames = false
  router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/video-studio', component: { render: () => null } }] })
  await router.push('/video-studio')
  mocks.record.mockReturnValue(true)
  mocks.status.mockResolvedValue({ online: true, models: [{ id: 'minimax-h3', available: true, executable: true, modes: ['text', 'image', 'first-last-frame'] }], defaults: { modelId: 'minimax-h3' } })
})
afterEach(() => { wrapper?.unmount(); vi.clearAllMocks(); vi.useRealTimers() })
describe('video submission recovery', () => {
  it('marks a failed environment refresh unconfirmed while preserving the draft and last catalog', async () => {
    const workspace = await setup()
    const previous = workspace.status.value, prompt = workspace.prompt.value
    expect(workspace.canGenerate.value).toBe(true)
    mocks.status.mockRejectedValueOnce(new Error('temporary status failure'))
    await workspace.loadStatus()
    expect(workspace.status.value).toBe(previous)
    expect(workspace.prompt.value).toBe(prompt)
    expect(workspace.environmentLabel.value).toBe('状态待确认')
    expect(workspace.modeBadge('image')).toBe('待重新检测 · 可编辑')
    expect(workspace.canGenerate.value).toBe(false)
    await workspace.loadStatus()
    expect(workspace.environmentLabel.value).toBe('可以生成')
    expect(workspace.statusError.value).toBe('')
    expect(workspace.canGenerate.value).toBe(true)
  })
  it.each([true, false])('clears recovered polling errors without losing a recording failure (recorded: %s)', async recorded => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const workspace = await setup()
    mocks.record.mockReturnValueOnce(recorded)
    mocks.frames.mockResolvedValueOnce({})
    mocks.create.mockResolvedValueOnce({ job: { id: 'recovering', status: 'running' } })
    mocks.fetch.mockRejectedValueOnce(new Error('temporary poll failure'))
      .mockResolvedValueOnce({ job: { id: 'recovering', status: 'succeeded' } })
    await workspace.submitVideo()
    await vi.advanceTimersByTimeAsync(1500)
    expect(workspace.job.value?.status).toBe('running')
    expect(workspace.canGenerate.value).toBe(false)
    await vi.advanceTimersByTimeAsync(1500)
    expect(workspace.job.value?.status).toBe('succeeded')
    if (recorded) expect(workspace.statusError.value).toBe('')
    else {
      expect(workspace.statusError.value).toContain('任务记录保存失败')
      await workspace.loadStatus()
      expect(workspace.statusError.value).toContain('任务记录保存失败')
    }
  })

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
  it('captures the complete new image context when submitted before its preview read finishes', async () => {
    mocks.realFrames = true
    mocks.consume.mockReturnValueOnce({ imageId: 'new-image', prompt: 'A new matching shot description', story: '', blueprintId: '', characterId: '', sceneId: '' })
    let finishPreview!: (value: Blob) => void
    mocks.image.mockResolvedValue(new Blob(['new image']))
      .mockReturnValueOnce(new Promise(resolve => { finishPreview = resolve }))
    mocks.upload.mockResolvedValueOnce({ name: 'new-image.png' })
    mocks.create.mockResolvedValueOnce({ job: { id: 'new-job', status: 'succeeded' } })
    const workspace = await setup(null)
    expect(workspace.canGenerate.value).toBe(true)
    await workspace.submitVideo()
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      image: 'new-image.png', prompt: 'A new matching shot description', aspectRatio: 'original', modelId: 'minimax-h3',
    }))
    expect(mocks.image.mock.calls.map(([id]) => id)).toEqual(['new-image', 'new-image'])
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ mode: 'image' }))
    finishPreview(new Blob(['new image']))
    await flushPromises()
  })
  it('consumes the old task link so refreshes and late reads cannot replace a newly submitted job', async () => {
    mocks.fetch.mockResolvedValueOnce({ job: { id: 'A', status: 'succeeded' } })
    await router.replace('/video-studio?job=A')
    const workspace = await setup()
    expect(workspace.job.value?.id).toBe('A')
    let finishOldRead!: (value: object) => void
    mocks.fetch.mockReturnValueOnce(new Promise(resolve => { finishOldRead = resolve }))
    await workspace.loadStatus()
    const oldSignal = mocks.fetch.mock.calls[1][1] as AbortSignal
    mocks.frames.mockResolvedValueOnce({})
    mocks.create.mockResolvedValueOnce({ job: { id: 'B', status: 'running' } })
    await workspace.submitVideo()
    await flushPromises()
    finishOldRead({ job: { id: 'A', status: 'succeeded' } })
    await flushPromises()
    expect(workspace.job.value?.id).toBe('B')
    expect(oldSignal.aborted).toBe(true)
    expect(router.currentRoute.value.query.job).toBeUndefined()
    await workspace.loadStatus()
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
    expect(workspace.canGenerate.value).toBe(false)
  })
  it('records an accepted job without replacing a newer task-center selection', async () => {
    mocks.fetch.mockResolvedValueOnce({ job: { id: 'A', status: 'succeeded' } })
    await router.replace('/video-studio?job=A')
    const workspace = await setup()
    let accept!: (value: object) => void
    mocks.frames.mockResolvedValueOnce({})
    mocks.create.mockReturnValueOnce(new Promise(resolve => { accept = resolve }))
    const pending = workspace.submitVideo()
    await flushPromises()
    mocks.fetch.mockResolvedValueOnce({ job: { id: 'C', status: 'succeeded' } })
    await router.push('/video-studio?job=C')
    await flushPromises()
    expect(workspace.job.value?.id).toBe('C')
    accept({ job: { id: 'B', status: 'running' } })
    await pending
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'B' }))
    expect(workspace.job.value?.id).toBe('C')
    expect(router.currentRoute.value.query.job).toBe('C')
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
  it('does not let a late poll undo cancellation or keep polling a cancelled job', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const workspace = await setup()
    mocks.frames.mockResolvedValueOnce({})
    mocks.create.mockResolvedValueOnce({ job: { id: 'running', status: 'running' } })
    let finishPoll!: (value: object) => void, finishCancel!: (value: object) => void
    mocks.fetch.mockReturnValueOnce(new Promise(resolve => { finishPoll = resolve }))
    mocks.cancel.mockReturnValueOnce(new Promise(resolve => { finishCancel = resolve }))
    await workspace.submitVideo()
    await vi.advanceTimersByTimeAsync(1500)
    const signal = mocks.fetch.mock.calls[0][1] as AbortSignal
    const cancellation = workspace.cancelJob()
    expect(signal.aborted).toBe(true)
    finishPoll({ job: { id: 'running', status: 'running' } })
    await vi.advanceTimersByTimeAsync(6000)
    expect(mocks.fetch).toHaveBeenCalledOnce()
    finishCancel({ job: { id: 'running', status: 'cancelled' } })
    await cancellation
    await vi.advanceTimersByTimeAsync(4500)
    expect(workspace.job.value?.status).toBe('cancelled')
    expect(mocks.fetch).toHaveBeenCalledOnce()
  })
  it('invalidates a selected-job refresh during cancellation while preserving a newer route selection', async () => {
    mocks.fetch.mockResolvedValueOnce({ job: { id: 'A', status: 'running' } })
    await router.replace('/video-studio?job=A')
    const workspace = await setup()
    let finishRead!: (value: object) => void, finishCancel!: (value: object) => void
    mocks.fetch.mockReturnValueOnce(new Promise(resolve => { finishRead = resolve }))
    await workspace.loadStatus()
    const signal = mocks.fetch.mock.calls[1][1] as AbortSignal
    mocks.cancel.mockReturnValueOnce(new Promise(resolve => { finishCancel = resolve }))
    const pending = workspace.cancelJob()
    expect(signal.aborted).toBe(true)
    await workspace.loadStatus()
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
    finishCancel({ job: { id: 'A', status: 'cancelled' } })
    await pending
    finishRead({ job: { id: 'A', status: 'running' } })
    await flushPromises()
    expect(workspace.job.value?.status).toBe('cancelled')

    // A different route owns the workspace even while its read is pending.
    mocks.cancel.mockReturnValueOnce(new Promise(resolve => { finishCancel = resolve }))
    const secondCancel = workspace.cancelJob()
    mocks.fetch.mockReturnValueOnce(new Promise(resolve => { finishRead = resolve }))
    await router.push('/video-studio?job=B')
    await flushPromises()
    const newerSignal = mocks.fetch.mock.calls[2][1] as AbortSignal
    finishCancel({ job: { id: 'A', status: 'running' } })
    await secondCancel
    expect(newerSignal.aborted).toBe(false)
    expect(workspace.job.value?.status).toBe('cancelled')
    finishRead({ job: { id: 'B', status: 'succeeded' } })
    await flushPromises()
    expect(workspace.job.value?.id).toBe('B')
  })
  it('stops reading a cached page task and resumes without cancelling its backend job', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const visible = ref(true)
    let workspace!: ReturnType<typeof useVideoWorkspace>
    const page = defineComponent({ setup() { workspace = useVideoWorkspace(); return () => null } })
    wrapper = mount(defineComponent({ setup: () => () => h(KeepAlive, null, { default: () => visible.value ? h(page) : null }) }), { global: { plugins: [router] } })
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
