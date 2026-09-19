import { defineComponent } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useVideoWorkspace } from './useVideoWorkspace'
import type { VideoFramesDeps } from '@/components/video/useVideoFrames'

const mocks = vi.hoisted(() => ({ create: vi.fn(), frames: vi.fn(), record: vi.fn() }))
vi.mock('vue-router', () => ({ useRoute: () => ({ path: '/video-studio', query: {} }), useRouter: () => ({ replace: vi.fn() }) }))
vi.mock('@/composables/useTaskCenter', () => ({ useTrackedTask: vi.fn() }))
vi.mock('@/composables/tasks/useBackendSelection', () => ({ useBackendSelection: () => ({ retry: vi.fn() }) }))
vi.mock('@/stores/videoStore', () => ({ useVideoStore: () => ({ recordVideoTask: mocks.record }) }))
vi.mock('@/api/videoApi', () => ({
  createVideoJob: mocks.create, fetchVideoJob: vi.fn(), cancelVideoJob: vi.fn(),
  fetchVideoStatus: async () => ({ online: true, models: [{ id: 'minimax-h3', available: true, executable: true, modes: ['text', 'image', 'first-last-frame'] }], defaults: { modelId: 'minimax-h3' } }),
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
afterEach(() => { wrapper?.unmount(); vi.clearAllMocks() })
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
})
