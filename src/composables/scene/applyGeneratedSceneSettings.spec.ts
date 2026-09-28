import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { applyGeneratedSceneSettings } from './applyGeneratedSceneSettings'
import type { UseDirectorPopularInput } from './useDirectorPopular'
import type { DrawEngine } from '@/types/promptHistory'

function setup(engine: DrawEngine = 'anima') {
  const drawEngine = ref<DrawEngine>(engine)
  const animaState = ref({ models: [{ id: 'krea', family: 'krea2', available: true, sizes: ['1024x1024'] }],
    loras: [], styleLoras: [], modelId: 'anima', cfg: 6, seed: null })
  const pb = { isPopular: false, sdParams: { cfg: 7, steps: 30, seed: -1, seedLock: false }, sdModelName: '',
    selections: { emotion: ['previous'] }, manualTags: new Set(['previous']), outfitOverride: { tokens: ['old_clothes'], replaced: [] }, visualDescription: 'old description',
    setChar: vi.fn(), setShot: vi.fn(), setLighting: vi.fn(), setComposition: vi.fn(), setColorMood: vi.fn(),
    applyModelProfile: vi.fn(), markParamTouched: vi.fn(), setArtistStyleIds: vi.fn() }
  const input = { pb, drawEngine, sdSize: ref('832x1216'), animaState,
    sd: { models: ref(['sd-model']), checkpoint: ref('sd-model') },
    setDrawEngine: vi.fn((value: DrawEngine) => { drawEngine.value = value }),
    applyModel: vi.fn((modelId: string) => Object.assign(animaState.value, { modelId, cfg: 6 })),
    patchAnimaState: vi.fn(patch => Object.assign(animaState.value, patch)) } as unknown as UseDirectorPopularInput
  return { input, pb, animaState, drawEngine }
}

describe('generated scene settings', () => {
  it('does not inject invalid dimensions from malformed saved metadata into generation state', () => {
    const { input, animaState } = setup('krea2')
    const notes = applyGeneratedSceneSettings({ version: 1, engine: 'krea2', prompt: 'rain', negative: '', parameters: { size: 'unavailable' } }, input)
    expect(notes).toContain('原画幅记录无效，保留当前画幅')
    expect(animaState.value).not.toHaveProperty('width')
  })
  it('restores duet identity and director decisions without carrying the previous manual prompt layers', () => {
    const { input, pb } = setup('sd')
    applyGeneratedSceneSettings({ version: 1, engine: 'sd', prompt: '2girls, original clothes', negative: 'text',
      parameters: { character: 'triad', shot: 'wide', lighting: 'golden', composition: 'rule3', colorMood: 'warm', emotion: ['happy'] } }, input)
    expect(pb.setChar).toHaveBeenCalledWith('triad')
    expect(pb.manualTags.size).toBe(0)
    expect(pb.outfitOverride).toBeNull()
    expect(pb.visualDescription).toBe('')
    expect(pb.selections.emotion).toEqual(['happy'])
    expect(pb.setShot).toHaveBeenCalledWith('wide')
    expect(pb.setLighting).toHaveBeenCalledWith('golden')
    expect(pb.setComposition).toHaveBeenCalledWith('rule3')
    expect(pb.sdParams).toMatchObject({ negative: true, negativeCustom: '' })
  })
  it('switches to recorded Krea engine before applying model and legitimate zero settings', () => {
    const { input, animaState, drawEngine } = setup()
    const notes = applyGeneratedSceneSettings({ version: 1, engine: 'krea2', prompt: 'rain', negative: '',
      parameters: { model: 'krea', size: '1024x1024', cfg: 0, steps: '12', seed: 0, loraStrength: 0 } }, input)
    expect(drawEngine.value).toBe('krea2')
    expect(animaState.value).toMatchObject({ modelId: 'krea', cfg: 0, steps: 12, seed: 0, width: 1024, loraId: '', loraStrength: 0 })
    expect(notes).toEqual(['提示词将按当前规则重新编译，画面可能与原图不同'])
  })
  it('reports unavailable model and LoRA instead of claiming exact restoration', () => {
    const { input } = setup()
    const notes = applyGeneratedSceneSettings({ version: 1, engine: 'anima', prompt: 'rain', negative: '',
      parameters: { model: 'missing', loraId: 'missing-lora' } }, input)
    expect(notes.join(' ')).toContain('原底模 missing 尚未确认可用')
    expect(notes.join(' ')).toContain('原角色 LoRA 尚未确认可用')
  })
  it('marks restored SD parameters touched and keeps seed zero locked', () => {
    const { input, pb } = setup()
    applyGeneratedSceneSettings({ version: 1, engine: 'sd', prompt: 'rain', negative: 'text',
      parameters: { checkpoint: 'sd-model', size: '832x1216', cfg: 0, seed: 0, hiresFix: false } }, input)
    expect(pb.sdModelName).toBe('sd-model')
    expect(pb.sdParams).toMatchObject({ cfg: 0, seed: 0, seedLock: true, hiresFix: false })
    expect(pb.markParamTouched).toHaveBeenCalledWith('cfg')
    expect(input.sdSize.value).toBe('832x1216')
  })
  it('does not patch another engine when the engine guard refuses switching', () => {
    const { input } = setup('sd')
    input.setDrawEngine = vi.fn()
    expect(applyGeneratedSceneSettings({ version: 1, engine: 'krea2', prompt: 'rain', negative: '', parameters: {} }, input)).toEqual(['原引擎当前不可用，请先选择支持的角色与引擎'])
    expect(input.patchAnimaState).not.toHaveBeenCalled()
  })
})
