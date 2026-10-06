import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import { usePromptBuilderStore } from '@/stores/promptBuilderStore'
import { useSceneStore } from '@/stores/sceneStore'
import { loadBlueprint } from './promptBlueprintActions'
import { useAnimaSession } from '@/composables/generation/useAnimaSession'
import type { ApiClient } from '@/api/client'

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
    refreshAnimaBackend: vi.fn(async () => true),
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
  it('reuses retired SD blueprint inputs without transferring generation parameters into Anima', async () => {
    const { pb, engine, size, context } = fixture()
    const originalParameters={...pb.sdParams}
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
    expect(pb.sdParams).toEqual(originalParameters)
    expect(engine.value).toBe('anima')
    expect(size.value).not.toBe('1216x832')
    expect(result.warnings.join(';')).toContain('SD 生成参数未跨引擎迁移')
  })

  it('restores popular identity, outfit override and Krea parameters without falling back to studio', async () => {
    const { pb, engine, animaState, context } = fixture()
    const result = await loadBlueprint({
      schema: 'aics-director-blueprint-v1', subject: 'popular', characterId: 'popular-one', outfitId: 'outfit-one',
      blueprintId: 'blueprint-one', story: '蓝图故事', visualDescription: 'Holding a paper lantern.',
      manualTags: ['looking_at_viewer'], referenceInput: { tags: ['looking_at_viewer'] }, outfitOverride: { tokens: ['winter_coat'], replaced: '默认服装' },
      drawEngine: 'krea2', size: '1024x1536',
      anima: { modelId: 'krea2-turbo-fp8', steps: 8, cfg: 1, seed: 0, sampler: 'euler', scheduler: 'simple' },
    }, context as any)
    expect(result.applied).toBe(true)
    expect(pb.subject).toMatchObject({ kind: 'popular', characterId: 'popular-one', outfitId: 'outfit-one', blueprintId: 'blueprint-one' })
    expect(pb.outfitOverride).toEqual({ tokens: ['winter_coat'], replaced: '默认服装' })
    expect(pb.referenceInput).toEqual({ tags: ['looking_at_viewer'] })
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


it.each(['new-owner', 'edited-draft', 'changed-engine', 'cancelled-refresh'] as const)('stops late blueprint parameter writes after %s', async reason => {
  const { pb, engine, animaState, context } = fixture()
  let finish!: (value: boolean) => void
  let current = true
  context.refreshAnimaBackend.mockImplementation(() => new Promise<boolean>(resolve => { finish = resolve }))
  const pending = loadBlueprint({ story: 'Imported story', drawEngine: 'anima', anima: { cfg: 11 }, size: '1216x832' },
    { ...context, isCurrent: () => current, getDrawEngine: () => engine.value } as any)
  expect(pb.story).toBe('Imported story')
  if (reason === 'new-owner') current = false
  if (reason === 'edited-draft') pb.setStory('Newer story')
  if (reason === 'changed-engine') engine.value = 'sd'
  animaState.value.cfg = 6
  finish(reason !== 'cancelled-refresh')
  expect((await pending).applied).toBe(false)
  expect(animaState.value.cfg).toBe(6)
  expect(pb.story).toBe(reason === 'edited-draft' ? 'Newer story' : 'Imported story')
})


it.each(['refresh-defaults', 'cfg-only', 'overlapping-cfg', 'sd-size-only'] as const)('distinguishes owned defaults from %s changes during discovery', async edit => {
  const { pb, engine, size, context } = fixture()
  const data = { ok: true, online: true, loras: [], models: [
    { id: 'first', family: 'anima', available: true, sizes: ['832x1216', '1216x832'], defaults: { cfg: 3, steps: 20 } },
    { id: 'second', family: 'anima', available: true, sizes: ['832x1216'], defaults: { cfg: 5, steps: 25 } },
  ] }
  let finish!: (value: typeof data) => void
  const request = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve })).mockResolvedValue(data)
  const session = useAnimaSession({ client: { request } as unknown as ApiClient,
    getCharacter: () => pb.char, isPopular: () => false, getFamily: () => 'anima',
    getRequest: () => null, onResult: vi.fn(), flash: vi.fn(), preferredSize: () => size.value })
  const pending = loadBlueprint({ story: 'Imported', drawEngine: 'anima', anima: { modelId: 'first', cfg: 11 }, size: '1216x832' }, {
    ...context, animaState: session.state, patchAnimaState: session.patchState, refreshAnimaBackend: session.refreshBackend,
    getDrawEngine: () => engine.value, getAnimaSettingsRevision: session.getSettingsRevision,
  } as Parameters<typeof loadBlueprint>[1])
  const editedCfg = edit === 'cfg-only' || edit === 'overlapping-cfg'
  if (editedCfg) session.state.value.cfg = 6
  if (edit === 'overlapping-cfg') void session.refreshBackend()
  if (edit === 'sd-size-only') size.value = '1024x1024'
  const revision = session.getSettingsRevision()
  finish(data)
  const result = await pending
  expect(result.applied).toBe(edit === 'refresh-defaults')
  expect(session.state.value.cfg).toBe(edit === 'refresh-defaults' ? 11 : editedCfg ? 6 : 3)
  if (edit !== 'refresh-defaults') expect(session.getSettingsRevision()).toBe(revision)
  if (edit === 'sd-size-only') expect(size.value).toBe('1024x1024')
  await session.refreshBackend()
  expect(session.state.value.cfg).toBe(edit === 'refresh-defaults' ? 11 : editedCfg ? 6 : 3)
  session.applyModel('second')
  expect(session.state.value.cfg).toBe(5)
  session.dispose()
})
