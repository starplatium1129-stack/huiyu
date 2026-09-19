import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import { usePromptBuilderStore } from '@/stores/promptBuilderStore'
import { useSceneStore } from '@/stores/sceneStore'
import { loadBlueprint } from './promptBlueprintActions'

function fixture() {
  const pb = usePromptBuilderStore()
  const engine = ref<'sd' | 'anima' | 'krea2'>('sd')
  const size = ref('832x1216')
  const animaState = ref({
    modelId: 'anima-aesthetic-v1.1', loraId: '', loraStrength: .85, styleLoraId: '',
    width: 832, height: 1216, steps: 24, cfg: 3, sampler: 'res_multistep', scheduler: 'simple', seed: null,
    hiresFix: false, hiresScale: 2, hiresDenoise: .35, teaCache: true, teaCacheThresh: .2,
    models: [
      { id: 'anima-aesthetic-v1.1', family: 'anima', sizes: ['832x1216'] },
      { id: 'krea2-turbo-fp8', family: 'krea2', sizes: ['1024x1536'] },
    ],
    loras: [{ id: 'L_NENE_V21_ANIMA' }], styleLoras: [{ id: 'style-one' }],
  })
  const patchAnimaState = vi.fn((patch: Record<string, unknown>) => Object.assign(animaState.value, patch))
  const context = {
    pb,
    selectScene: (scene: any) => pb.loadScene(scene),
    selectPopularSource: vi.fn(),
    selectBlueprint: (blueprint: any) => pb.setPopularBlueprint(blueprint.id),
    setDirectorMode: (mode: 'basic' | 'pro') => { pb.directorMode = mode },
    setDrawEngine: (value: typeof engine.value) => { engine.value = value },
    applyRecommendedSize: (value: string) => {
      size.value = value
      const [width, height] = value.split('x').map(Number)
      patchAnimaState({ width, height })
    },
    refreshAnimaBackend: vi.fn(async () => {}),
    animaState,
    patchAnimaState,
    sdSize: size,
  }
  return { pb, engine, size, animaState, context }
}

beforeEach(() => {
  setActivePinia(createPinia())
  const store = useSceneStore()
  store.scenes = [{ id: 'scene-one', title: '场景一', story: '场景原故事', char: 'nene', tags: [] }] as any
  store.popularCharacters = [{
    id: 'popular-one', displayName: '角色一', identityTokens: ['popular_one'], exactTokens: [], aliases: [],
    outfits: [{ id: 'outfit-one', name: '服装一', default: true, tokens: ['dress'], prose: 'a dress' }],
  }] as any
  store.sceneBlueprints = [{ id: 'blueprint-one', characterId: 'popular-one', title: '蓝图一', category: 'daily', promptTokens: [], negativeTokens: [] }] as any
})

describe('director blueprint round-trip', () => {
  it('restores the complete studio decision stack and clamps unsafe numeric input', async () => {
    const { pb, engine, size, context } = fixture()
    const result = await loadBlueprint({
      schema: 'aics-director-blueprint-v1', subject: 'studio', char: 'nene', sceneId: 'scene-one',
      story: '用户改写故事', visualDescription: 'A red umbrella beside the window.', directorMode: 'pro',
      selections: { emotion: ['relaxed', 'unknown'], shot: 'close', lighting: 'window', composition: 'rule3' },
      colorMood: 'sad', manualTags: ['red_umbrella', 'red_umbrella'], artistStyleIds: ['kantoku'],
      drawEngine: 'sd', size: '1216x832', sdParams: { cfg: 999, steps: 0, seed: 42, negativeCustom: 'blur' },
    }, context as any)
    expect(result.applied).toBe(true)
    expect(result.warnings).toContain('部分未知情绪选项已跳过')
    expect(pb.story).toBe('用户改写故事')
    expect(pb.visualDescription).toContain('red umbrella')
    expect(pb.selections).toMatchObject({ emotion: ['relaxed'], shot: 'close', lighting: 'window', composition: 'rule3' })
    expect(pb.colorMood).toBe('sad')
    expect([...pb.manualTags]).toEqual(['red_umbrella'])
    expect(pb.artistStyleIds).toEqual(['kantoku'])
    expect(pb.sdParams.cfg).toBe(20)
    expect(pb.sdParams.steps).toBe(1)
    expect(engine.value).toBe('sd')
    expect(size.value).toBe('1216x832')
  })

  it('restores popular identity, outfit override and Krea parameters without falling back to studio', async () => {
    const { pb, engine, animaState, context } = fixture()
    const result = await loadBlueprint({
      schema: 'aics-director-blueprint-v1', subject: 'popular', characterId: 'popular-one', outfitId: 'outfit-one',
      blueprintId: 'blueprint-one', story: '蓝图故事', visualDescription: 'Holding a paper lantern.',
      manualTags: ['looking_at_viewer'], outfitOverride: { tokens: ['winter_coat'], replaced: '默认服装' },
      drawEngine: 'krea2', size: '1024x1536',
      anima: { modelId: 'krea2-turbo-fp8', steps: 8, cfg: 1, seed: 0, sampler: 'euler', scheduler: 'simple' },
    }, context as any)
    expect(result.applied).toBe(true)
    expect(pb.subject).toMatchObject({ kind: 'popular', characterId: 'popular-one', outfitId: 'outfit-one', blueprintId: 'blueprint-one' })
    expect(pb.outfitOverride).toEqual({ tokens: ['winter_coat'], replaced: '默认服装' })
    expect(engine.value).toBe('krea2')
    expect(animaState.value).toMatchObject({ modelId: 'krea2-turbo-fp8', width: 1024, height: 1536, steps: 8, cfg: 1, seed: 0 })
  })

  it('rejects unknown schema and missing popular references without mutating the current subject', async () => {
    const { pb, context } = fixture()
    const original = JSON.parse(JSON.stringify(pb.subject))
    expect((await loadBlueprint({ schema: 'other', story: 'x' }, context as any)).applied).toBe(false)
    expect((await loadBlueprint({ subject: 'popular', characterId: 'missing', outfitId: 'missing' }, context as any)).applied).toBe(false)
    expect(pb.subject).toEqual(original)
  })
})
