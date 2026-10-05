import { effectScope, nextTick, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClientError } from '@/api/client'
import { useVideoStudioDraft, type VideoStudioDraftDeps } from './useVideoStudioDraft'

const mocks = vi.hoisted(() => ({ get: vi.fn(), fetch: vi.fn(), clear: vi.fn(), save: vi.fn(), store: { videoDraft: null as unknown, videoTask: null as { jobId: string } | null } }))
vi.mock('@/storage/artworkRepository', () => ({ artworkRepository: { getImage: mocks.get } }))
vi.mock('@/api/videoApi', () => ({ fetchVideoJob: mocks.fetch }))
vi.mock('@/stores/videoStore', () => ({ useVideoStore: () => ({
  get videoDraft() { return mocks.store.videoDraft },
  get videoTask() { return mocks.store.videoTask },
  clearVideoTask: mocks.clear, saveVideoDraft: mocks.save,
}) }))

function setup() {
  const deps: VideoStudioDraftDeps = {
    selectedMode: ref('text'), prompt: ref(''), negative: ref(''), selectedModelId: ref('minimax-h3'),
    aspectRatio: ref('landscape'), quality: ref('standard'), steps: ref(4), duration: ref(3),
    camera: ref('still'), motion: ref('subtle'), seedText: ref(''), videoImageId: ref(''),
    lastFrameImageId: ref(''), videoImageUrl: ref(''), lastFrameUrl: ref(''), onPersistError: vi.fn(),
  }
  const scope = effectScope()
  return { deps, scope, tools: scope.run(() => useVideoStudioDraft(deps))! }
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.store.videoDraft = { mode: 'image', videoImageId: 'draft-first', lastFrameImageId: '' }
  mocks.store.videoTask = null
  mocks.get.mockResolvedValue(new Blob(['draft']))
  mocks.save.mockReturnValue(true)
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:draft')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

describe('video draft asynchronous ownership', () => {
  it('preserves and persists frame IDs after temporary read failures so recovery can retry', async () => {
    vi.useFakeTimers()
    mocks.store.videoDraft = { mode: 'first-last-frame', videoImageId: 'draft-first', lastFrameImageId: 'draft-last' }
    mocks.get.mockRejectedValueOnce(new Error('作品原图暂时不可用'))
      .mockRejectedValueOnce(new DOMException('作品原图读取超时', 'TimeoutError'))
    const { deps, scope, tools } = setup()
    const stop = scope.run(() => tools.startDraftWatch())!
    expect(await tools.restoreDraft()).toEqual({ firstFrameLost: false, lastFrameLost: false })
    await nextTick()
    await vi.advanceTimersByTimeAsync(350)
    expect(deps.videoImageId.value).toBe('draft-first')
    expect(deps.lastFrameImageId.value).toBe('draft-last')
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ videoImageId: 'draft-first', lastFrameImageId: 'draft-last' }))
    expect(deps.onPersistError).toHaveBeenCalledWith(expect.stringContaining('暂时无法读取'))
    expect(deps.onPersistError).not.toHaveBeenCalledWith(expect.stringContaining('失效'))
    expect(await tools.restoreDraft()).toEqual({ firstFrameLost: false, lastFrameLost: false })
    expect(deps.videoImageUrl.value).toBe('blob:draft')
    expect(deps.lastFrameUrl.value).toBe('blob:draft')
    stop()
    scope.stop()
  })

  it('still clears frame IDs when storage confirms the images are absent or empty', async () => {
    mocks.store.videoDraft = { mode: 'first-last-frame', videoImageId: 'draft-first', lastFrameImageId: 'draft-last' }
    mocks.get.mockResolvedValueOnce(null).mockResolvedValueOnce(new Blob([]))
    const { deps, scope, tools } = setup()
    expect(await tools.restoreDraft()).toEqual({ firstFrameLost: true, lastFrameLost: true })
    expect(deps.videoImageId.value).toBe('')
    expect(deps.lastFrameImageId.value).toBe('')
    expect(deps.onPersistError).not.toHaveBeenCalled()
    scope.stop()
  })

  it('does not replace a frame selected while the draft image was loading', async () => {
    let finish!: (blob: Blob) => void
    mocks.get.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    const { deps, scope, tools } = setup()
    const restoring = tools.restoreDraft()
    deps.videoImageId.value = 'new-first'
    deps.videoImageUrl.value = 'blob:new-first'
    finish(new Blob(['old']))
    await restoring
    expect(deps.videoImageId.value).toBe('new-first')
    expect(deps.videoImageUrl.value).toBe('blob:new-first')
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    scope.stop()
  })

  it('does not clear a newer frame when the old draft image is missing', async () => {
    let finish!: (blob: null) => void
    mocks.get.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    const { deps, scope, tools } = setup()
    const restoring = tools.restoreDraft()
    deps.videoImageId.value = 'new-first'
    finish(null)
    expect(await restoring).toEqual({ firstFrameLost: false, lastFrameLost: false })
    expect(deps.videoImageId.value).toBe('new-first')
    scope.stop()
  })

  it('aborts image reads and rejects their late results when the owner is disposed', async () => {
    let finish!: (blob: Blob) => void
    mocks.get.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    const { scope, tools } = setup()
    const restoring = tools.restoreDraft()
    const signal = mocks.get.mock.calls[0][1] as AbortSignal
    scope.stop()
    expect(signal.aborted).toBe(true)
    finish(new Blob(['late']))
    await restoring
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('does not forget a new task when an old reconnect reports a missing job', async () => {
    let fail!: (error: Error) => void
    mocks.store.videoTask = { jobId: 'old-job' }
    mocks.fetch.mockReturnValueOnce(new Promise((_resolve, reject) => { fail = reject }))
    const { scope, tools } = setup()
    const reconnecting = tools.reconnectTask()
    mocks.store.videoTask = { jobId: 'new-job' }
    fail(new ApiClientError('gone', { kind: 'http', status: 404 }))
    expect(await reconnecting).toEqual({ kind: 'none' })
    expect(mocks.clear).not.toHaveBeenCalled()
    scope.stop()
  })
})
