import { describe, expect, it, vi } from 'vitest'
import { saveGeneratedArtwork, type LegacyArtworkDefaults, type SaveGeneratedArtworkDependencies } from './saveGeneratedArtwork'

function fixture() {
  const defaults: LegacyArtworkDefaults = {
    subject: { kind: 'studio' }, character: 'nene', scene: null, sceneTitle: null, story: '', visualDescription: '', seed: -1,
    emotion: [], shot: null, lighting: null, composition: null, colorMood: null, manual_tags: [], lora: null,
    cfg: 7, steps: 20, sampler: 'euler', scheduler: 'normal', model: 'fixture-model', size: '832x1216',
    hiresFix: false, hiresScale: 2, hiresUpscaler: '', hiresSteps: 0, hiresDenoise: 0.5, faceDetailer: false, project: '', artistStyleIds: [],
  }
  let staged = false
  const deps: SaveGeneratedArtworkDependencies = {
    withStaging: async work => { staged = true; try { return await work() } finally { staged = false } },
    putImage: vi.fn(async () => { expect(staged).toBe(true); return 'new-image' }),
    deleteImage: vi.fn(async () => { expect(staged).toBe(true) }),
    cacheThumbnail: vi.fn(async () => {}), measureBlob: vi.fn(async () => ({ width: 100, height: 200 })),
    now: () => 1234, nextId: now => now * 1000 + 1,
    resolveLegacyDefaults: vi.fn(() => defaults), normalizeArtistStyleIds: vi.fn(() => ['normalized']),
    appendArtwork: vi.fn(async entry => { expect(staged).toBe(true); return [{ id: 'old', unknown: true }, entry] }),
  }
  return { deps, defaults, input: { blob: new Blob(['neutral image']), prompt: 'A quiet river.' }, staged: () => staged }
}

describe('保存生成作品用例：显式依赖，无 Pinia 或页面', () => {
  it('显式空场景标题与无 LoRA 不回退到当前表单', async () => {
    const f = fixture()
    f.deps.resolveLegacyDefaults = () => ({ ...f.defaults, sceneTitle: 'later scene', lora: 'later lora' })
    expect(await saveGeneratedArtwork({ ...f.input, sceneTitle: null, lora: null }, f.deps))
      .toMatchObject({ ok: true, entry: { sceneTitle: null, lora: null } })
  })
  it('在保护内完成图片和记录提交，返回可显示历史及完整生成记录', async () => {
    const f = fixture()
    const result = await saveGeneratedArtwork(f.input, f.deps)
    expect(f.staged()).toBe(false)
    expect(result).toMatchObject({ ok: true, entry: { id: 1234001, timestamp: 1234, image_id: 'new-image', width: 100, height: 200,
      checkpoint: 'fixture-model', artistStyleIds: ['normalized'] }, history: [{ id: 'old', unknown: true }, { id: 1234001 }] })
    expect(f.deps.deleteImage).not.toHaveBeenCalled()
  })

  it('拒绝暂存保护时不触发写入，也不把锁错误伪装为存储成功', async () => {
    const f = fixture(), error = new Error('staging unavailable')
    f.deps.withStaging = async () => { throw error }
    await expect(saveGeneratedArtwork(f.input, f.deps)).rejects.toBe(error)
    expect(f.deps.putImage).not.toHaveBeenCalled()
    expect(f.deps.appendArtwork).not.toHaveBeenCalled()
  })

  it('异步测量前捕获兼容默认值，不等待派生缩略图', async () => {
    const f = fixture()
    let release!: () => void
    f.deps.cacheThumbnail = vi.fn(() => new Promise<void>(() => {}))
    f.deps.measureBlob = vi.fn(async () => {
      await new Promise<void>(resolve => { release = resolve })
      return { width: null, height: null }
    })
    const saving = saveGeneratedArtwork(f.input, f.deps)
    await vi.waitFor(() => expect(f.deps.measureBlob).toHaveBeenCalled())
    expect(f.deps.resolveLegacyDefaults).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ prompt: f.input.prompt }))
    release()
    expect(await saving).toMatchObject({ ok: true, entry: { width: null, height: null } })
  })

  it('等待暂存锁期间，显式输入数组与默认值数组均不再跟随表单变化', async () => {
    const f = fixture(), emotion = ['calm'], tags = ['river'], loras = [{ id:'style', strength:0.5 }]
    let release!: () => void
    const wait = new Promise<void>(resolve => { release = resolve })
    f.deps.withStaging = async work => { await wait; return work() }
    f.deps.putImage = async () => 'image'
    f.deps.appendArtwork = async entry => [entry]
    f.deps.resolveLegacyDefaults = () => ({ ...f.defaults, manual_tags: tags })
    const saving = saveGeneratedArtwork({ ...f.input, emotion, loras }, f.deps)
    emotion.push('happy'); tags.push('lake'); loras[0]!.strength = 1
    release()
    expect(await saving).toMatchObject({ ok:true, entry:{ emotion:['calm'], manual_tags:['river'], loras:[{ id:'style', strength:0.5 }] } })
  })

  it('上下文在首次图片等待前复制，后续修改上下文数组不改变入册事实', async () => {
    const f = fixture()
    const context = { characterId: 'popular-a', history: { emotion: ['calm'] }, story: 'submitted' }
    f.deps.putImage = async () => { context.history.emotion.push('happy'); context.story = 'later'; return 'new-image' }
    f.deps.resolveLegacyDefaults = entry => {
      expect(entry.emotion).toEqual(['calm'])
      return { ...f.defaults, subject: { kind: 'popular', characterId: entry.characterId!, outfitId: '' } }
    }
    expect(await saveGeneratedArtwork({ ...f.input, context }, f.deps)).toMatchObject({ ok: true, entry: { story: 'submitted', emotion: ['calm'] } })
  })

  it.each(['putImage', 'measureBlob', 'appendArtwork'] as const)('%s 失败保留原错误，仅拥有图片后才补偿', async failure => {
    const f = fixture(), error = new Error(failure)
    f.deps[failure] = vi.fn().mockRejectedValue(error)
    const result = await saveGeneratedArtwork(f.input, f.deps)
    expect(result).toEqual({ ok: false, error })
    if (failure === 'putImage') expect(f.deps.deleteImage).not.toHaveBeenCalled()
    else expect(f.deps.deleteImage).toHaveBeenCalledExactlyOnceWith('new-image')
    expect(f.staged()).toBe(false)
  })

  it('缩略图拒绝仍能保存，补偿失败也不覆盖原始错误', async () => {
    const f = fixture(), error = new Error('commit failed')
    f.deps.cacheThumbnail = vi.fn().mockRejectedValue(new Error('thumbnail failed'))
    expect((await saveGeneratedArtwork(f.input, f.deps)).ok).toBe(true)
    f.deps.appendArtwork = vi.fn().mockRejectedValue(error)
    f.deps.deleteImage = vi.fn().mockRejectedValue(new Error('cleanup failed'))
    expect(await saveGeneratedArtwork(f.input, f.deps)).toEqual({ ok: false, error })
  })
})
