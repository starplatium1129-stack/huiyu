import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useVideoStore, type VideoCtxPayload } from './videoStore'

/**
 * videoStore 契约测试：
 *  - 跨页交接载荷的存/取/一次性消费
 *  - sessionStorage 持久与水合（模拟刷新后新 store 实例）
 *  - 分镜列表追加与角标派生
 */

let nextFixtureId = 0
function makeCtx(overrides: Partial<VideoCtxPayload> = {}): VideoCtxPayload {
  return {
    imageId: `fixture-image-${++nextFixtureId}`,
    prompt: 'a test prompt',
    story: 'a story',
    blueprintId: null,
    characterId: 'nene',
    sceneId: null,
    ...overrides,
  }
}

describe('videoStore · 单图出视频交接', () => {
  beforeEach(() => {
    sessionStorage.clear()
    setActivePinia(createPinia())
  })

  it('stage 后可消费，消费即清除（一次性语义）', () => {
    const store = useVideoStore()
    expect(store.consumeImageCtx()).toBeNull()
    expect(sessionStorage.getItem('aics_video_ctx')).toBeNull()
    const ctx = makeCtx({ imageId: 'img-once' })
    expect(store.stageImageCtx(ctx)).toBe(true)
    expect(store.pendingImageCtx?.imageId).toBe('img-once')

    const taken = store.consumeImageCtx()
    expect(taken?.imageId).toBe('img-once')
    expect(store.pendingImageCtx).toBeNull()
    expect(sessionStorage.getItem('aics_video_ctx')).toBeNull()
    expect(store.consumeImageCtx()).toBeNull()
  })

  it('stage 失败（存储抛错）时状态回滚为空', () => {
    const store = useVideoStore()
    const quotaStorage = {
      getItem: () => null,
      removeItem: () => {},
      setItem: () => {
        throw new DOMException('quota exceeded', 'QuotaExceededError')
      },
    } as unknown as Storage
    vi.stubGlobal('sessionStorage', quotaStorage)
    try {
      expect(store.stageImageCtx(makeCtx())).toBe(false)
      expect(store.pendingImageCtx).toBeNull()
      // F4：append 失败返回明确失败标记，不再静默挤掉旧镜头
      expect(store.appendShotCtx(makeCtx())).toEqual({ ok: false, count: 0 })
      expect(store.shotsPending).toBe(0)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('F4：追加时存储写失败回滚内存，已有镜头一个都不动', () => {
    const store = useVideoStore()
    store.appendShotCtx(makeCtx({ imageId: 'img-first' }))
    store.appendShotCtx(makeCtx({ imageId: 'img-second' }))
    expect(store.shotsPending).toBe(2)

    // 存储中途损坏：第三条写不进去（append 路径只会调 setItem）
    const flakyStorage = {
      getItem: () => null,
      removeItem: () => {},
      setItem: () => { throw new DOMException('quota exceeded', 'QuotaExceededError') },
    } as unknown as Storage
    // 直接读真实 sessionStorage 校验持久层未被篡改
    const persistedBefore = sessionStorage.getItem('aics_video_shots_ctx')
    vi.stubGlobal('sessionStorage', flakyStorage)
    try {
      const result = store.appendShotCtx(makeCtx({ imageId: 'img-third' }))
      expect(result.ok).toBe(false)
      expect(result.count).toBe(2)
      expect(store.pendingShotCtxs.map(c => c.imageId)).toEqual(['img-first', 'img-second'])
    } finally {
      vi.unstubAllGlobals()
    }
    expect(sessionStorage.getItem('aics_video_shots_ctx')).toBe(persistedBefore)
  })

  it('新实例从 sessionStorage 水合（模拟路由跳转/刷新后的视频页）', () => {
    const ctx = makeCtx({ imageId: 'img-hydrate' })
    sessionStorage.setItem('aics_video_ctx', JSON.stringify(ctx))

    // 模拟全新 Pinia 实例（等价于页面刷新后重新 createApp）
    setActivePinia(createPinia())
    const fresh = useVideoStore()
    expect(fresh.pendingImageCtx?.imageId).toBe('img-hydrate')

    // 损坏载荷不致命：回退为空
    sessionStorage.setItem('aics_video_ctx', '{broken json')
    setActivePinia(createPinia())
    expect(useVideoStore().pendingImageCtx).toBeNull()
  })
})

describe('videoStore · 分镜短片批量交接', () => {
  beforeEach(() => {
    sessionStorage.clear()
    setActivePinia(createPinia())
  })

  it('append 累积并驱动 shotsPending 角标；consume 取走全部并清零', () => {
    const store = useVideoStore()
    expect(store.shotsPending).toBe(0)

    expect(store.appendShotCtx(makeCtx())).toEqual({ ok: true, count: 1 })
    expect(store.appendShotCtx(makeCtx({ characterId: 'natsume' }))).toEqual({ ok: true, count: 2 })
    expect(store.shotsPending).toBe(2)

    const taken = store.consumeShotCtxs()
    expect(taken.map(c => c.characterId)).toEqual(['nene', 'natsume'])
    expect(store.shotsPending).toBe(0)
    expect(sessionStorage.getItem('aics_video_shots_ctx')).toBeNull()
  })

  it('stageShotCtxs 整批替换（bridgeShotsToVideo 的批量路径）', () => {
    const store = useVideoStore()
    store.appendShotCtx(makeCtx())

    const batch = [makeCtx(), makeCtx(), makeCtx()]
    expect(store.stageShotCtxs(batch)).toBe(true)
    expect(store.shotsPending).toBe(3)
    expect(store.consumeShotCtxs().length).toBe(3)
  })

  it('水合过滤非法条目（缺 imageId 的历史脏数据）', () => {
    sessionStorage.setItem('aics_video_shots_ctx', JSON.stringify([
      makeCtx({ imageId: 'img-good' }),
      { prompt: 'no imageId here' },
      'garbage',
    ]))
    setActivePinia(createPinia())
    const store = useVideoStore()
    expect(store.shotsPending).toBe(1)
    expect(store.consumeShotCtxs()[0].imageId).toBe('img-good')
  })

  it('F3：outfitId 随交接载荷持久化（旧载荷缺省为 undefined 不炸）', () => {
    const store = useVideoStore()
    store.appendShotCtx(makeCtx({ outfitId: 'witch_canonical' }))
    setActivePinia(createPinia())
    const fresh = useVideoStore()
    expect(fresh.pendingShotCtxs[0].outfitId).toBe('witch_canonical')
    fresh.consumeShotCtxs()
    fresh.appendShotCtx(makeCtx())
    expect(fresh.pendingShotCtxs[0].outfitId).toBeUndefined()
  })
})

describe('videoStore · 创作草稿与任务记录（F1）', () => {
  beforeEach(() => {
    sessionStorage.clear()
    setActivePinia(createPinia())
  })

  it('视频草稿保存后新实例水合；清除后回到 null', () => {
    const store = useVideoStore()
    expect(store.videoDraft).toBeNull()
    expect(store.saveVideoDraft({
      mode: 'image', prompt: '黄昏电车站', negative: '', modelId: 'minimax-h3',
      aspectRatio: 'original', quality: 'standard', steps: 8, duration: 5,
      camera: 'push', motion: 'natural', seedText: '42',
      videoImageId: 'img-1', lastFrameImageId: '', updatedAt: Date.now(),
    })).toBe(true)

    setActivePinia(createPinia())
    const fresh = useVideoStore()
    expect(fresh.videoDraft?.prompt).toBe('黄昏电车站')
    expect(fresh.videoDraft?.videoImageId).toBe('img-1')
    fresh.clearVideoDraft()
    expect(fresh.videoDraft).toBeNull()
    expect(sessionStorage.getItem('aics_video_draft_v1')).toBeNull()
  })

  it('任务记录与分镜批次记录可水合；非法载荷回退 null', () => {
    const store = useVideoStore()
    expect(store.recordVideoTask({ jobId: 'job-1', mode: 'image', submittedAt: 1 })).toBe(true)
    expect(store.recordShotsBatch({ batchId: 'batch-1', submittedAt: 2 })).toBe(true)

    setActivePinia(createPinia())
    const fresh = useVideoStore()
    expect(fresh.videoTask?.jobId).toBe('job-1')
    expect(fresh.shotsBatch?.batchId).toBe('batch-1')

    sessionStorage.setItem('aics_video_task_v1', '{"jobId":""}')
    sessionStorage.setItem('aics_video_shots_batch_v1', '{broken')
    setActivePinia(createPinia())
    const corrupted = useVideoStore()
    expect(corrupted.videoTask).toBeNull()
    expect(corrupted.shotsBatch).toBeNull()
  })

  it('草稿写入失败返回 false（调用方提示），内存态不被污染', () => {
    const store = useVideoStore()
    vi.stubGlobal('sessionStorage', {
      getItem: () => null,
      removeItem: () => {},
      setItem: () => { throw new DOMException('quota', 'QuotaExceededError') },
    } as unknown as Storage)
    try {
      expect(store.saveVideoDraft({
        mode: 'text', prompt: 'x', negative: '', modelId: 'minimax-h3',
        aspectRatio: 'landscape', quality: 'standard', steps: 8, duration: 3,
        camera: 'still', motion: 'subtle', seedText: '',
        videoImageId: '', lastFrameImageId: '', updatedAt: 0,
      })).toBe(false)
      expect(store.videoDraft).toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
