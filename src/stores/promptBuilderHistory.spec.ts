import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { usePromptBuilderStore } from './promptBuilderStore'
import { usePromptHistoryStore } from './promptHistoryStore'
import { captureResultContext } from '@/utils/resultContext'
import type { HistoryEntry } from '@/types/promptHistory'

const io = vi.hoisted(() => ({ put: vi.fn(), remove: vi.fn(), append: vi.fn(), thumbnail: vi.fn(), kvSet: vi.fn(), stageExit: vi.fn(), events: [] as string[] }))
vi.mock('@/composables/useImageStore', () => ({ imgPut: io.put, imgDelete: io.remove }))
vi.mock('@/composables/useKVStore', () => ({ kvGet: vi.fn(), kvSet: io.kvSet }))
vi.mock('@/utils/imageThumb', () => ({ blobThumbDataUrl: io.thumbnail, thumbKey: (id: string) => `thumb:${id}` }))
vi.mock('@/storage/artworkRepository', () => ({ artworkRepository: { appendArtwork: io.append } }))
vi.mock('@/storage/artworkSession', () => ({ withArtworkStaging: async (work: () => Promise<unknown>) => {
  io.events.push('stage-enter')
  try { return await work() } finally { io.stageExit(); io.events.push('stage-exit') }
} }))

const blob = () => new Blob(['neutral image fixture'], { type: 'image/png' })
beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  io.events.length = 0
  io.stageExit.mockReset()
  io.put.mockImplementation(async () => { io.events.push('put'); return 'owned-image' })
  io.remove.mockResolvedValue(undefined)
  io.thumbnail.mockImplementation(async () => { io.events.push('thumbnail'); return null })
  io.kvSet.mockResolvedValue(undefined)
  io.append.mockImplementation(async (entry: HistoryEntry) => { io.events.push('append'); return [entry] })
  vi.stubGlobal('createImageBitmap', vi.fn(async () => { io.events.push('measure'); return { width: 832, height: 1216, close: vi.fn() } }))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('入册抽取前后的兼容特征', () => {
  it('在暂存保护内依次写图、启动缩略图、测量并提交，成功前不发布历史', async () => {
    const pb = usePromptBuilderStore()
    io.stageExit.mockImplementation(() => expect(pb.history).toHaveLength(2))
    io.append.mockImplementation(async (entry: HistoryEntry) => {
      io.events.push('append')
      expect(pb.history).toEqual([])
      return [{ id: 'legacy', parent_id: 'missing', extension: { keep: true } }, entry]
    })
    const saved = await pb.commitHistoryEntry({ blob: blob(), prompt: 'A quiet river.' })
    expect(io.events).toEqual(['stage-enter', 'put', 'thumbnail', 'measure', 'append', 'stage-exit'])
    expect(saved).toMatchObject({ width: 832, height: 1216, image_id: 'owned-image', styleLoraId: null })
    expect(pb.history[0]).toEqual({ id: 'legacy', parent_id: 'missing', extension: { keep: true } })
    expect(pb.history[1]).toEqual(saved)
  })

  it('显式 null/空值与零值按原优先级保留，model 优先于旧 checkpoint 字段', async () => {
    const pb = usePromptBuilderStore()
    pb.sceneId = 'current-scene'
    pb.story = 'current story'
    pb.lastSeed = 99
    const saved = await pb.commitHistoryEntry({ blob: blob(), prompt: 'A quiet river.', scene: null, story: '',
      shot: null, lighting: null, composition: null, colorMood: null, emotion: [], manual_tags: [],
      engine: 'anima', profile: 'submitted-profile', model: 'submitted-model', checkpoint: 'ignored-legacy-checkpoint', seed: 0, cfg: 0, steps: 0,
      loraId: 'submitted-lora', loraStrength: 0, hiresFix: false, hiresScale: 0, hiresSteps: 0, hiresDenoise: 0, faceDetailer: false,
      parentId: '0012', project: '', negative: '',
    })
    expect(saved).toMatchObject({ scene: null, story: '', shot: null, lighting: null, composition: null, colorMood: null,
      emotion: [], manual_tags: [], engine: 'anima', profile: 'submitted-profile', checkpoint: 'submitted-model', model: 'submitted-model', seed: 0, cfg: 0, steps: 0,
      loraId: 'submitted-lora', loraStrength: 0, hiresFix: false, hiresScale: 0, hiresSteps: 0, hiresDenoise: 0, faceDetailer: false, parent_id: '0012', project: '', negative: '' })
  })

  it('上下文先覆盖条目身份与故事，热门作品清空工作室 LoRA', async () => {
    const pb = usePromptBuilderStore()
    pb.setPopularSubject('popular-original', 'outfit-original', 'blueprint-original')
    pb.story = 'submitted story'
    const context = captureResultContext(pb)
    pb.setStudioSubject()
    pb.story = 'later story'
    const saved = await pb.commitHistoryEntry({ blob: blob(), prompt: 'A quiet river.', context,
      character: 'wrong', story: 'wrong', subject: 'studio', lora: 'old', loraId: 'old', loraStrength: 1,
      loras: [{ id: 'old', strength: 1 }], styleLoraId: 'krea-style', parentId: 0,
    })
    expect(saved).toMatchObject({ character: 'popular-original', characterId: 'popular-original', outfitId: 'outfit-original',
      blueprintId: 'blueprint-original', scene: 'blueprint-original', story: 'submitted story', subject: 'popular',
      noLora: true, lora: null, loraId: null, loraStrength: null, loras: [], styleLoraId: 'krea-style', parent_id: 0 })
  })

  it('缺省的旧输入仍在测量后读取兼容默认值；提交时机调整留给下一批', async () => {
    const pb = usePromptBuilderStore()
    let release!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve })
    const measure = vi.spyOn(usePromptHistoryStore(), 'measureBlob').mockImplementation(async () => {
      await waiting
      return { width: null, height: null }
    })
    const saving = pb.commitHistoryEntry({ blob: blob(), prompt: 'A quiet river.' })
    await vi.waitFor(() => expect(measure).toHaveBeenCalled())
    pb.story = 'legacy fallback after measurement'
    pb.projectId = 'late-project'
    release()
    expect(await saving).toMatchObject({ story: 'legacy fallback after measurement', project: 'late-project', width: null, height: null })
  })

  it('同一毫秒连续保存保留既有序号；提交记录不复用可变数组', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1800000000000)
    const pb = usePromptBuilderStore()
    const emotion = ['calm'], loras = [{ id: 'style', strength: 0.5 }]
    const first = await pb.commitHistoryEntry({ blob: blob(), prompt: 'A quiet river.', emotion, loras })
    const second = await pb.commitHistoryEntry({ blob: blob(), prompt: 'A still lake.' })
    emotion.push('happy'); loras[0]!.strength = 1
    expect(first!.id).not.toBe(second!.id)
    expect(first).toMatchObject({ emotion: ['calm'], loras: [{ id: 'style', strength: 0.5 }] })
    expect(Object.isFrozen(first!.loras)).toBe(true)
  })

  it('图片失败不写记录、不清理其他图片，保留原错误', async () => {
    const error = new Error('image write failed')
    io.put.mockRejectedValue(error)
    expect(await usePromptBuilderStore().commitHistoryEntry({ blob: blob(), prompt: 'A quiet river.' })).toBeNull()
    expect(io.append).not.toHaveBeenCalled()
    expect(io.remove).not.toHaveBeenCalled()
    expect(console.warn).toHaveBeenCalledWith('commitHistoryEntry failed', error)
  })

  it('持久化失败只清理本次图片，返回失败且不发布内存记录', async () => {
    const error = new Error('metadata write failed')
    io.append.mockRejectedValue(error)
    io.remove.mockRejectedValue(new Error('cleanup failed'))
    const pb = usePromptBuilderStore()
    expect(await pb.commitHistoryEntry({ blob: blob(), prompt: 'A quiet river.' })).toBeNull()
    expect(pb.history).toEqual([])
    expect(io.remove).toHaveBeenCalledExactlyOnceWith('owned-image')
    expect(console.warn).toHaveBeenCalledWith('commitHistoryEntry failed', error)
  })

  it('缩略图失败保持原图与成功记录', async () => {
    io.thumbnail.mockRejectedValue(new Error('thumbnail failed'))
    const saved = await usePromptBuilderStore().commitHistoryEntry({ blob: blob(), prompt: 'A quiet river.' })
    expect(saved?.image_id).toBe('owned-image')
    expect(io.remove).not.toHaveBeenCalled()
  })
})
