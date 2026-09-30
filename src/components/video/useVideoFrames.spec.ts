import { ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useVideoFrames, type VideoFramesDeps } from './useVideoFrames'
import { imgGet, imgPut, imgDeleteMany } from '@/composables/useImageStore'
import { uploadVideoImage } from '@/api/videoApi'

vi.mock('@/composables/useImageStore', () => ({ imgGet: vi.fn(), imgPut: vi.fn(), imgDeleteMany: vi.fn() }))
vi.mock('@/api/videoApi', () => ({ uploadVideoImage: vi.fn() }))
vi.mock('@/stores/videoStore', () => ({ useVideoStore: () => ({ consumeImageCtx: vi.fn() }) }))
vi.mock('@/stores/sceneStore', () => ({ useSceneStore: () => ({ sceneBlueprints: [] }) }))
const context = { story: '', blueprintId: '', characterId: '', sceneId: '', prompt: '' }

function setup() {
  const deps: VideoFramesDeps = {
    selectedMode: ref('image'), aspectRatio: ref('original'), selectedModelId: ref('minimax-h3'), prompt: ref(''),
    videoImageId: ref('old'), videoImageUrl: ref('blob:old'), firstFrameName: ref('stale.png'),
    lastFrameImageId: ref('old-last'), lastFrameUrl: ref('blob:last'), lastFrameName: ref('stale-last.png'),
    uploadingImage: ref(false), status: ref(null), statusError: ref(''),
  }
  return { deps, frames: useVideoFrames(deps) }
}
beforeEach(() => {
  vi.mocked(imgGet).mockReset().mockResolvedValue(new Blob(['image']))
  vi.mocked(imgPut).mockReset().mockResolvedValue('stored')
  vi.mocked(imgDeleteMany).mockReset().mockResolvedValue(undefined)
  vi.mocked(uploadVideoImage).mockReset().mockResolvedValue({ ok: true, name: 'fresh.png' } as Awaited<ReturnType<typeof uploadVideoImage>>)
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:new')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('video input identity and retries', () => {
  it('clears stale uploaded names and tail frame when bringing in a new picture', async () => {
    const { deps, frames } = setup()
    await frames.applyVideoCtx({ ...context, imageId: 'new', prompt: 'A new shot' })
    expect(deps.videoImageId.value).toBe('new')
    expect(deps.firstFrameName.value).toBe('')
    expect(deps.lastFrameImageId.value).toBe('')
    expect(await frames.resolveSubmitFrames('image')).toEqual({ image: 'fresh.png', lastFrame: undefined })
    expect(imgGet).toHaveBeenLastCalledWith('new')
  })
  it('does not leave an old frame usable when the new original is missing', async () => {
    vi.mocked(imgGet).mockResolvedValue(null)
    const { deps, frames } = setup()
    await frames.applyVideoCtx({ ...context, imageId: 'missing' })
    expect(deps.videoImageId.value).toBe('')
    expect(deps.videoImageUrl.value).toBe('')
    expect(deps.statusError.value).toContain('失效')
    await expect(frames.resolveSubmitFrames('image')).rejects.toThrow('首帧')
  })
  it('reuploads durable originals on every submission instead of reusing cleaned server names', async () => {
    const { deps, frames } = setup()
    await frames.resolveSubmitFrames('first-last-frame')
    await frames.resolveSubmitFrames('first-last-frame')
    expect(uploadVideoImage).toHaveBeenCalledTimes(4)
    expect(deps.uploadingImage.value).toBe(false)
  })
  it('rejects a frame changed while preparing a submission and releases the busy state', async () => {
    let resolve!: (value: Blob) => void
    vi.mocked(imgGet).mockReturnValueOnce(new Promise(done => { resolve = done }))
    const { deps, frames } = setup()
    const pending = frames.resolveSubmitFrames('image')
    frames.clearFirstFrame()
    resolve(new Blob(['original']))
    await expect(pending).rejects.toThrow('已更换')
    expect(deps.uploadingImage.value).toBe(false)
  })
  it('ignores a slow old context when a newer picture has been selected', async () => {
    let resolve!: (value: Blob) => void
    vi.mocked(imgGet).mockReturnValueOnce(new Promise(done => { resolve = done }))
    const { deps, frames } = setup()
    const old = frames.applyVideoCtx({ ...context, imageId: 'slow', prompt: 'Old shot' })
    await frames.applyVideoCtx({ ...context, imageId: 'latest', prompt: 'Latest shot' })
    resolve(new Blob(['old']))
    await old
    expect(deps.videoImageId.value).toBe('latest')
    expect(deps.prompt.value).toBe('Latest shot')
  })
  it('does not restore an uploaded frame after the user removes it', async () => {
    let resolve!: (value: string) => void
    vi.mocked(imgPut).mockReturnValueOnce(new Promise(done => { resolve = done }))
    const { deps, frames } = setup()
    const event = { target: { files: [new File(['new'], 'new.png', { type: 'image/png' })], value: '' } } as unknown as Event
    const pending = frames.handleFrameFile(event, 'first')
    await vi.waitFor(() => expect(imgPut).toHaveBeenCalled())
    frames.clearFirstFrame()
    resolve('new')
    await pending
    expect(deps.videoImageId.value).toBe('')
    expect(deps.uploadingImage.value).toBe(false)
    expect(imgDeleteMany).toHaveBeenCalledWith(['new'])
  })
  it('aborts an in-flight frame upload when its owner is disposed', async () => {
    let finish!: (value: Awaited<ReturnType<typeof uploadVideoImage>>) => void
    vi.mocked(uploadVideoImage).mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    const { frames } = setup()
    const event = { target: { files: [new File(['new'], 'new.png', { type: 'image/png' })], value: '' } } as unknown as Event
    const pending = frames.handleFrameFile(event, 'first')
    await vi.waitFor(() => expect(uploadVideoImage).toHaveBeenCalled())
    const signal = vi.mocked(uploadVideoImage).mock.calls[0][2]!
    frames.disposeFrames()
    expect(signal.aborted).toBe(true)
    finish({ ok: true, name: 'late.png', bytes: 3 })
    await pending
    expect(imgPut).not.toHaveBeenCalled()
  })
})
