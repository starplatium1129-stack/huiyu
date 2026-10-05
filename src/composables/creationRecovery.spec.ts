import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, effectScope, nextTick, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { useVideoStore } from '@/stores/videoStore'
import { usePromptBuilderStore } from '@/stores/promptBuilderStore'
import { useShotImport } from '@/components/video/useShotImport'
import { useVideoStudioDraft, type VideoStudioDraftDeps } from '@/components/video/useVideoStudioDraft'
import { useTempResult, type TempResultDeps } from '@/composables/prompt/useTempResult'
import { captureResultContext } from '@/utils/resultContext'
import { readTempResult } from '@/utils/tempResult'
import type { AnimaResult, AnimaGenerationState } from '@/types/anima'
import type { ShotDraft } from '@/components/video/shotListTypes'
import type { ReferenceCard } from '@/components/video/useReferenceCards'
import { ARTWORK_HISTORY_KV_KEY, ARTWORK_PROJECTS_KV_KEY, ARTWORK_TRASH_KV_KEY } from '@/utils/storageKeys'

// State handoffs do not depend on the generated catalog's cache-busting hash.
vi.mock('virtual:data-version', () => ({ DATA_VERSION: 1 }))
const io = vi.hoisted(() => ({ put: vi.fn(), get: vi.fn(), remove: vi.fn(), upload: vi.fn(), fetchJob: vi.fn(), kvGet: vi.fn(), kvSet: vi.fn(), kvSetMany: vi.fn(), kv: new Map<string, unknown>() }))
vi.mock('@/composables/useImageStore', () => ({
  imgPut: io.put,
  imgGet: io.get,
  imgDelete: io.remove,
  imgGetRecord: io.get,
  imgPutRecord: io.put,
  imgDeleteMany: io.remove,
}))
vi.mock('@/composables/useKVStore', () => ({ kvGet: io.kvGet, kvSet: io.kvSet, kvSetMany: io.kvSetMany }))
vi.mock('@/storage/artworkMutation', () => ({ withArtworkMutation: (work: () => Promise<unknown>) => work() }))
vi.mock('@/utils/imageThumb', () => ({ blobThumbDataUrl: vi.fn(), thumbKey: (id: string) => id }))
vi.mock('@/api/videoApi', () => ({ uploadVideoImage: io.upload, fetchVideoJob: io.fetchJob }))

beforeEach(() => {
  vi.clearAllMocks()
  sessionStorage.clear()
  setActivePinia(createPinia())
  io.put.mockResolvedValue('temp-image')
  io.get.mockResolvedValue(null)
  io.remove.mockResolvedValue(undefined)
  io.kv.clear()
  io.kvGet.mockImplementation(async key => io.kv.get(key) ?? null)
  io.kvSetMany.mockImplementation(async (entries: Array<{ key: string; value: unknown }>) => {
    // Match production: serialize before committing all records in one transaction.
    const snapshot = JSON.parse(JSON.stringify(entries)) as typeof entries
    const next = new Map(io.kv)
    for (const entry of snapshot) next.set(entry.key, entry.value)
    io.kv = next
  })
  io.kvSet.mockImplementation((key, value) => io.kvSetMany([{ key, value }]))
  vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 832, height: 1216, close: vi.fn() }))
})

describe('创作状态交接回归', () => {
  it('入册保留提交时的角色、服装、描述与零值参数，不读取后来的表单', async () => {
    const pb = usePromptBuilderStore()
    pb.setPopularSubject('character-a', 'outfit-a', 'blueprint-a')
    pb.setStory('Story A')
    pb.visualDescription = 'Description A'
    const context = captureResultContext(pb)
    pb.setPopularSubject('character-b', 'outfit-b', 'blueprint-b')
    pb.setStory('Story B')
    pb.visualDescription = 'Description B'
    const entry = await pb.commitHistoryEntry({ context, blob: new Blob(['image']), prompt: 'Prompt A', cfg: 0 })
    expect(entry).toMatchObject({ characterId: 'character-a', outfitId: 'outfit-a', blueprintId: 'blueprint-a', story: 'Story A', visualDescription: 'Description A', cfg: 0 })
  })

  it('入册后的软删与撤销通过默认仓库事务同步历史、项目和回收站', async () => {
    const pb = usePromptBuilderStore()
    const entry = await pb.commitHistoryEntry({ blob: new Blob(['image']), prompt: 'A quiet landscape' })
    expect(entry).not.toBeNull()
    io.get.mockResolvedValue({
      id: entry!.image_id, blob: new Blob(['image']), name: 'image.png', type: 'image/png', size: 5, created_at: Date.now(),
    })
    io.kv.set(ARTWORK_PROJECTS_KV_KEY, [{ id: 'project', name: '作品项目', history_ids: [entry!.id] }])
    io.kvSetMany.mockClear()
    await pb.removeHistoryEntry(entry!.id)
    expect(pb.history).toEqual([])
    expect(io.kv.get(ARTWORK_TRASH_KV_KEY)).toHaveLength(1)
    expect(await pb.restoreHistoryEntry(entry!.id)).toBe(true)
    expect(pb.history).toEqual([entry])
    expect(io.kv.get(ARTWORK_TRASH_KV_KEY)).toEqual([])
    expect(io.kv.get(ARTWORK_PROJECTS_KV_KEY)).toEqual([{ id: 'project', name: '作品项目', history_ids: [String(entry!.id)] }])
    expect(io.kvSetMany).toHaveBeenCalledTimes(2)
    for (const [entries] of io.kvSetMany.mock.calls) {
      expect(entries.map((item: { key: string }) => item.key)).toEqual([ARTWORK_HISTORY_KV_KEY, ARTWORK_PROJECTS_KV_KEY, ARTWORK_TRASH_KV_KEY])
    }
  })

  it('参考卡在异步装配前分别占位，失败首帧保留重试凭据', async () => {
    const store = useVideoStore()
    for (const id of ['a', 'b']) store.appendShotCtx({ imageId: id, characterId: 'same', outfitId: id, prompt: 'A quiet landscape', story: '', blueprintId: null, sceneId: null })
    const shots = ref<ShotDraft[]>([])
    const cards = ref<ReferenceCard[]>([{ label: '', images: [] }])
    const assemble = vi.fn(async (id: string, index = 0) => { cards.value[index].label = id; return true })
    const importer = useShotImport({ shots, frameRequests: new Map(), referenceCards: cards, selectCardCharacter: assemble })
    const result = await importer.importShotsFromDrawing()
    expect(assemble.mock.calls).toEqual([['same', 0, 'a'], ['same', 1, 'b']])
    expect(shots.value.map(shot => shot.cast)).toEqual(['1', '2'])
    expect(shots.value.map(shot => shot.imageId)).toEqual(['a', 'b'])
    expect(result).toMatchObject({ imported: 2, framesReady: 0, framesPending: 2 })
    expect(store.shotsPending).toBe(0)
    store.appendShotCtx({ imageId: 'next', characterId: 'same', outfitId: 'a', prompt: 'Another quiet landscape', story: '', blueprintId: null, sceneId: null })
    await importer.importShotsFromDrawing()
    expect(assemble).toHaveBeenCalledTimes(2)
    expect(cards.value).toHaveLength(2)
    expect(shots.value[2].cast).toBe('1')
  })

  it('旧首帧恢复不覆盖手选图片，也不释放新请求的归属', async () => {
    const shots = ref([{ imageId: 'old', imageName: '', imageUrl: '' } as ShotDraft])
    const target = shots.value[0], frameRequests = new Map<ShotDraft, AbortController>()
    const importer = useShotImport({ shots, frameRequests, referenceCards: ref([]), selectCardCharacter: async () => true })
    let finish!: (value: unknown) => void
    io.get.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    const pending = importer.mountShotFrame(target, 'old')
    frameRequests.get(target)!.abort()
    const newer = new AbortController()
    frameRequests.set(target, newer)
    Object.assign(target, { imageId: 'new', imageName: 'manual.png', imageUrl: 'blob:manual' })
    finish(new Blob(['old']))
    expect(await pending).toBeUndefined()
    expect(target.imageName).toBe('manual.png')
    expect(frameRequests.get(target)).toBe(newer)
    expect(io.upload).not.toHaveBeenCalled()
  })

  it('清空镜头后恢复旧数组中的当前与后续项都跳过，不产生无主首帧', async () => {
    const shots = ref(['one', 'two'].map(imageId => ({ imageId, imageName: '', imageUrl: '' } as ShotDraft)))
    const importer = useShotImport({ shots, frameRequests: new Map(), referenceCards: ref([]), selectCardCharacter: async () => true })
    let finish!: (value: unknown) => void
    io.get.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    const pending = importer.retryPendingFrames()
    shots.value = []
    finish(new Blob(['old']))
    expect(await pending).toEqual({ fixed: 0, remaining: 0 })
    expect(io.get).toHaveBeenCalledTimes(1)
    expect(io.upload).not.toHaveBeenCalled()
  })

  it('恢复失败保留重试引用，已有请求跳过，新导入私有草稿仍可挂载', async () => {
    const shots = ref([{ imageId: 'recoverable', imageName: '', imageUrl: '' } as ShotDraft])
    const target = shots.value[0], frameRequests = new Map<ShotDraft, AbortController>()
    const importer = useShotImport({ shots, frameRequests, referenceCards: ref([]), selectCardCharacter: async () => true })
    io.get.mockRejectedValueOnce(new Error('HTTP 500'))
    expect(await importer.retryPendingFrames()).toEqual({ fixed: 0, remaining: 1 })
    expect(target.imageId).toBe('recoverable')
    const active = new AbortController()
    frameRequests.set(target, active)
    expect(await importer.retryPendingFrames()).toEqual({ fixed: 0, remaining: 0 })
    expect(active.signal.aborted).toBe(false)
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:imported')
    io.get.mockResolvedValueOnce(new Blob(['imported']))
    io.upload.mockResolvedValueOnce({ name: 'imported.png' })
    useVideoStore().appendShotCtx({ imageId: 'imported', characterId: '', prompt: 'A quiet landscape', story: '', blueprintId: null, sceneId: null })
    try {
      expect(await importer.importShotsFromDrawing()).toMatchObject({ imported: 1, framesReady: 1, framesPending: 0 })
      expect(shots.value[1].imageName).toBe('imported.png')
      expect(create).toHaveBeenCalledOnce()
    } finally { create.mockRestore() }
  })

  it('导入过程中离页，不消费还未落位的镜头', async () => {
    const store = useVideoStore()
    store.appendShotCtx({ imageId: 'a', characterId: 'a', prompt: 'A quiet landscape', story: '', blueprintId: null, sceneId: null })
    let finish!: (value: boolean) => void
    const scope = effectScope()
    const importer = scope.run(() => useShotImport({ shots: ref([]), frameRequests: new Map(), referenceCards: ref([{ label: '', images: [] }]), selectCardCharacter: () => new Promise(resolve => { finish = resolve }) }))!
    const running = importer.importShotsFromDrawing()
    scope.stop()
    finish(true)
    expect(await running).toBeNull()
    expect(store.shotsPending).toBe(1)
  })
})

function videoDeps(): VideoStudioDraftDeps {
  return {
    selectedMode: ref('text'), prompt: ref(''), negative: ref(''), selectedModelId: ref('minimax-h3'),
    aspectRatio: ref('landscape'), quality: ref('standard'), steps: ref(4), duration: ref(3),
    camera: ref('still'), motion: ref('subtle'), seedText: ref(''), videoImageId: ref(''),
    lastFrameImageId: ref(''), videoImageUrl: ref(''), lastFrameUrl: ref(''), onPersistError: vi.fn(),
  }
}

describe('视频草稿与任务', () => {
  it('输入后立即离页也保存草稿，不依赖防抖定时器完成', async () => {
    const deps = videoDeps()
    const scope = effectScope()
    const tools = scope.run(() => useVideoStudioDraft(deps))!
    const stop = scope.run(() => tools.startDraftWatch())!
    deps.prompt.value = 'A boat drifts across a quiet pond.'
    await nextTick()
    stop()
    scope.stop()
    expect(useVideoStore().videoDraft?.prompt).toBe(deps.prompt.value)
  })

  it('网络暂不可达时保留任务记录，允许稍后重连', async () => {
    const store = useVideoStore()
    store.recordVideoTask({ jobId: 'job-a', mode: 'text', submittedAt: 1 })
    io.fetchJob.mockRejectedValue(new Error('offline'))
    expect(await useVideoStudioDraft(videoDeps()).reconnectTask()).toEqual({ kind: 'unreachable' })
    expect(store.videoTask?.jobId).toBe('job-a')
  })
})

function tempHarness() {
  const pb = usePromptBuilderStore()
  const state = ref({ result: null, resultContext: null } as unknown as AnimaGenerationState)
  const deps = {
    pb, sd: {}, drawEngine: ref('anima'), animaState: state,
    patchAnimaState: (patch: Partial<AnimaGenerationState>) => Object.assign(state.value, patch),
    displayResultUrl: computed(() => state.value.result?.url ?? ''), displayResultSeed: computed(() => 7), generationBusy: ref(false),
    livePrompt: computed(() => ''), negativePrompt: computed(() => ''),
    historyGenerationFields: () => ({}), resultContext: ref(null), autoSaveToGallery: ref(true), setDrawEngine: vi.fn(),
  } as unknown as TempResultDeps
  const tools = useTempResult(deps)
  const result = { url: 'blob:result-a', blob: new Blob(['image']), metadata: { engine: 'anima', prompt: 'A quiet landscape', negative: '', seed: 7, width: 832, height: 1216 } } as AnimaResult
  state.value.result = result
  return { pb, deps, tools, result }
}

describe('临时成片持久化', () => {
  it('入册返回 null 时按失败处理，回退临时保存并如实标记', async () => {
    const { pb, tools, result } = tempHarness()
    vi.spyOn(pb, 'commitHistoryEntry').mockResolvedValue(null)
    await tools.handleAnimaResult(result)
    expect(readTempResult()?.imageId).toBe('temp-image')
    expect(tools.resultArchived.value).toBe(false)
    expect(tools.resultTemporary.value).toBe(true)
  })

  it('用户丢弃后晚完成的图片写入不能复活旧临时成片', async () => {
    const { deps, tools, result } = tempHarness()
    deps.autoSaveToGallery.value = false
    let finish!: (id: string) => void
    let entered!: () => void
    const writeStarted = new Promise<void>(resolve => { entered = resolve })
    io.put.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; entered() }))
    const pending = tools.handleAnimaResult(result)
    // Completion actions load lazily; discard after the real write has begun,
    // so this still exercises cleanup of an image that completes too late.
    await writeStarted
    tools.discardTemp()
    finish('late-image')
    await pending
    expect(readTempResult()).toBeNull()
    expect(io.remove).toHaveBeenCalledWith(['late-image'])
  })
})
