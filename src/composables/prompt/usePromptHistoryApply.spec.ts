import { beforeEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { effectScope, ref } from 'vue'
import { usePromptBuilderStore } from '@/stores/promptBuilderStore'
import { useSceneStore } from '@/stores/sceneStore'
import type { ArtworkRecord } from '@/types/artwork'
import type { AnimaGenerationState } from '@/types/anima'
import { applyInterrogateResult } from './applyInterrogateResult'
import { usePromptHistoryApply } from './usePromptHistoryApply'
import { usePromptHistoryReuse } from './usePromptHistoryReuse'
import { useAnimaSession } from '@/composables/generation/useAnimaSession'
import type { ApiClient } from '@/api/client'
import type { HistoryReuseSelection } from '@/types/historyReuse'

beforeEach(() => setActivePinia(createPinia()))
function setup() {
  const pb = usePromptBuilderStore()
  const state = ref({ phase: 'idle', family: 'anima', models: [], loras: [], online: true, modelId: 'old', loraId: '', styleLoraId: '', width: 832, height: 1216, steps: 20, cfg: 5 } as unknown as AnimaGenerationState)
  const flash = vi.spyOn(pb, 'flash')
  const refresh = vi.fn(async () => true)
  const engine = ref<'sd' | 'anima' | 'krea2'>('sd'), size = ref('832x1216')
  const deps = { pb, animaState: state, patchAnimaState: (patch: Partial<AnimaGenerationState>) => { Object.assign(state.value, patch) }, clearAnimaResult: vi.fn(), refreshAnimaBackend: refresh, setDrawEngine: vi.fn(value => { engine.value = value }), resetBlueprintRotation: vi.fn(), sdSize: size, drawEngine: engine }
  const api = usePromptHistoryApply(deps)
  return { pb, state, flash, refresh, deps, engine, size, ...api }
}
const entry = (overrides: Partial<ArtworkRecord> = {}) => ({ id: 12, engine: 'sd', character: 'nene', manual_tags: ['dof'], emotion: ['calm'], shot: 'wide', lighting: 'moon', composition: 'rule3', colorMood: 'warmth', story: 'Saved story', seed: -1, cfg: 0, steps: 25, sampler: 'Euler', scheduler: '', size: '832x1216', project: 'saved-project', ...overrides })

it('clears stale draft fields and restores tags, decisions, project and legal zeroes', async () => {
  const { pb, applyHistory } = setup()
  useSceneStore().tags = [{ en: 'depth_of_field', cn: '景深', cat: 'Camera', aliases: ['dof'] }]
  pb.visualDescription = 'Unrelated image'; pb.sdParams.negativeCustom = 'old negative'; pb.sdParams.seedLock = true
  await applyHistory(entry())
  expect(pb.visualDescription).toBe('')
  expect(pb.sdParams).toMatchObject({ negativeCustom: '', seedLock: false, seed: -1, cfg: 0, scheduler: '' })
  expect([...pb.manualTags]).toEqual(['depth_of_field'])
  expect(pb.projectId).toBe('saved-project')
  expect(pb.sdParamsTouched.has('cfg')).toBe(true)
})
it('restores saved popular decisions instead of leaving current or blueprint values', async () => {
  const { pb, applyHistory } = setup()
  const sceneStore = useSceneStore()
  sceneStore.popularCharacters = [{ id: 'fixture', outfits: [{ id: 'daily' }] }] as unknown as typeof sceneStore.popularCharacters
  await applyHistory(entry({ engine: 'anima', subject: 'popular', characterId: 'fixture', outfitId: 'daily' }))
  expect(pb.selections).toEqual({ emotion: ['calm'], shot: 'wide', lighting: 'moon', composition: 'rule3' })
  expect(pb.colorMood).toBe('warmth')
})
it('unknown engines leave the current draft intact', async () => {
  const { pb, applyHistory } = setup()
  pb.story = 'Keep me'
  await applyHistory(entry({ engine: 'unknown' }))
  expect(pb.story).toBe('Keep me')
})

it('loads incomplete old records without claiming exact reproduction', async () => {
  const { pb, applyHistory } = setup()
  await applyHistory({ id: '0001', cfg: 0, seed: '0', emotion: {}, manual_tags: [42] })
  expect(pb.sdParams.cfg).toBe(0)
  expect(pb.sdParams.seed).toBe(0)
  expect(pb.historyRestoreReport?.notes.join(';')).toContain('无法精确复现')
  expect(pb.historyRestoreReport?.title).toContain('0001')
})

it('reuses style and camera without changing the current subject, prompt, parameters or album', async () => {
  const { pb, state, engine, applyHistory } = setup()
  pb.setChar('natsume'); pb.story = 'Current story'; pb.visualDescription = 'Current prose'
  pb.manualTags = new Set(['current']); pb.projectId = 'current-project'; pb.sdParams.negativeCustom = 'current negative'
  const parameters = { ...pb.sdParams }, anima = { ...state.value }
  await applyHistory(entry(), true, { style: true, camera: true, prompts: false, parameters: false })
  expect(pb.char).toBe('natsume')
  expect(pb.selections.shot).toBe('wide'); expect(pb.selections.composition).toBe('rule3')
  expect(pb.selections.lighting).toBe('moon'); expect(pb.colorMood).toBe('warmth')
  expect(pb.story).toBe('Current story'); expect(pb.visualDescription).toBe('Current prose')
  expect([...pb.manualTags]).toEqual(['current']); expect(pb.projectId).toBe('current-project')
  expect(pb.sdParams).toEqual(parameters); expect(state.value).toEqual(anima)
  engine.value = 'krea2'; state.value.styleLoraId = 'current-style'
  await applyHistory(entry({ engine: 'krea2', styleLoraId: null }), true, { style: true, camera: false, prompts: false, parameters: false })
  expect(state.value.styleLoraId).toBe('')
  expect(pb.sdParams).toEqual(parameters)
})

it('reuses prompt inputs for a matching subject while preserving camera, style and numeric parameters', async () => {
  const { pb, applyHistory } = setup()
  pb.setShot('close'); pb.setComposition('center'); pb.setLighting('sun'); pb.setColorMood('cool')
  pb.sdParams.negativeCustom = 'stale compiled negative'; const cfg = pb.sdParams.cfg
  await applyHistory(entry({ negative: 'historical exclusion', visualDescription: 'Saved prose' }), true, { style: false, camera: false, prompts: true, parameters: false })
  expect(pb.story).toBe('Saved story'); expect(pb.visualDescription).toBe('Saved prose')
  expect(pb.selections).toEqual({ emotion: ['calm'], shot: 'close', lighting: 'sun', composition: 'center' })
  expect(pb.colorMood).toBe('cool'); expect(pb.sdParams.cfg).toBe(cfg)
  expect(pb.sdParams.negativeCustom).toBe('')
  expect(pb.historyRestoreReport?.notes.join(';')).toContain('原作负向快照未写入')
})

it('does not import another character or outfit prompt, or parameters from an unrecorded engine', async () => {
  const { pb, applyHistory } = setup()
  pb.setChar('natsume'); pb.story = 'Keep'; pb.manualTags = new Set(['keep'])
  const parameters = { ...pb.sdParams }
  await applyHistory(entry({ engine: undefined }), true, { style: false, camera: false, prompts: true, parameters: true })
  expect(pb.story).toBe('Keep'); expect([...pb.manualTags]).toEqual(['keep']); expect(pb.sdParams).toEqual(parameters)
  expect(pb.historyRestoreReport?.notes.join(';')).toContain('原角色或服装与当前条件不同')
  const scenes = useSceneStore()
  scenes.popularCharacters = [{ id: 'fixture', outfits: [{ id: 'daily' }, { id: 'formal' }] }] as unknown as typeof scenes.popularCharacters
  pb.setPopularSubject('fixture', 'formal')
  await applyHistory(entry({ subject: 'popular', characterId: 'fixture', outfitId: 'daily' }), true, { style: false, camera: false, prompts: true, parameters: false })
  expect(pb.subject).toMatchObject({ characterId: 'fixture', outfitId: 'formal' }); expect(pb.story).toBe('Keep')
})

it('keeps the draft intact when a complete recipe refers to a removed character or outfit', async () => {
  const { pb, applyHistory } = setup()
  pb.story = 'Keep'; pb.sdParams.negativeCustom = 'Keep negative'
  expect(await applyHistory(entry({ subject: 'popular', characterId: 'removed', outfitId: 'daily' }))).toBe(false)
  expect(pb.story).toBe('Keep'); expect(pb.sdParams.negativeCustom).toBe('Keep negative')
  expect(pb.subject.kind).toBe('studio')
})

it('does not write Anima numeric parameters into the inactive SD editor', async () => {
  const { pb, applyHistory } = setup()
  const seed = pb.sdParams.seed, cfg = pb.sdParams.cfg
  await applyHistory(entry({ engine: 'anima', seed: 77, cfg: 3.2, negative: 'different native negative' }))
  expect(pb.sdParams.seed).toBe(seed); expect(pb.sdParams.cfg).toBe(cfg)
})

it('cancels a detached reuse choice without changing the draft and blocks confirmation during generation', async () => {
  const { pb, deps } = setup(), busy = ref(false), scope = effectScope()
  const onApplied = vi.fn()
  const reuse = scope.run(() => usePromptHistoryReuse({ ...deps, generationBusy: busy, onApplied }))!
  const source = entry(); pb.story = 'Keep'
  expect(await reuse.duplicateHistory(source)).toBe(true)
  source.emotion!.push('later edit')
  expect(reuse.reuseRequest.value?.record.emotion).toEqual(['calm'])
  reuse.cancelReuse()
  expect(await reuse.applyReuse('full')).toBe(false); expect(pb.story).toBe('Keep')
  expect(onApplied).not.toHaveBeenCalled()
  await reuse.resumeHistory(source); busy.value = true
  expect(await reuse.applyReuse('full')).toBe(false); expect(pb.story).toBe('Keep')
  scope.stop(); expect(reuse.reuseRequest.value).toBeNull()
})


it('waits for winning backend discovery before reporting recipe fallbacks', async () => {
  const { pb, deps } = setup()
  const responses: Array<{ resolve(value: object): void; reject(error: Error): void }> = []
  const client = { request: () => new Promise((resolve, reject) => responses.push({ resolve, reject })) } as unknown as ApiClient
  const session = useAnimaSession({ client, getCharacter: () => 'nene', isPopular: () => false,
    getFamily: () => 'krea2', getRequest: () => null, preferredSize: () => '', onResult: vi.fn(), flash: vi.fn() })
  const { applyHistory } = usePromptHistoryApply({ ...deps, animaState: session.state,
    patchAnimaState: session.restoreSettings, refreshAnimaBackend: session.refreshBackend })
  const before = pb.historyRestoreReport
  const restoring = applyHistory(entry({ engine: 'krea2', model: 'missing', styleLoraId: 'old-style' }))
  const replacement = session.refreshBackend()
  responses[0].reject(new Error('superseded'))
  await Promise.resolve(); await Promise.resolve()
  expect(pb.historyRestoreReport).toBe(before)
  responses[1].resolve({ ok: true, online: true, models: [{ id: 'available', family: 'krea2', available: true, sizes: ['1024x1024'] }] })
  await replacement
  expect(await restoring).toBe(true)
  expect(pb.historyRestoreReport?.notes.join(';')).toContain('missing → available')
  expect(pb.historyRestoreReport?.notes.join(';')).toContain('old-style → 不可用')
  expect(pb.historyRestoreReport?.notes.join(';')).toContain('832 → 1024')
  session.dispose()
})

it.each([
  { selection: 'full' as HistoryReuseSelection, failure: false, dispose: false },
  { selection: { style: false, camera: false, prompts: false, parameters: true }, failure: false, dispose: true },
  { selection: 'full' as HistoryReuseSelection, failure: true, dispose: false },
])('suppresses late restore reports and flashes after cancellation (%j)', async ({ selection, failure, dispose }) => {
  const { pb, deps, refresh, flash, engine } = setup(), scope = effectScope(), onApplied = vi.fn()
  engine.value = 'anima'
  let resolve!: (value: boolean) => void, reject!: (error: Error) => void
  refresh.mockReturnValueOnce(new Promise<boolean>((done, fail) => { resolve = done; reject = fail }))
  const reuse = scope.run(() => usePromptHistoryReuse({ ...deps, generationBusy: ref(false), onApplied }))!
  await reuse.resumeHistory(entry({ engine: 'anima' }))
  const restoring = reuse.applyReuse(selection)
  await Promise.resolve()
  expect(reuse.reuseBusy.value).toBe(true)
  const before = pb.historyRestoreReport
  flash.mockClear()
  if (dispose) scope.stop()
  else reuse.cancelReuse()
  if (failure) reject(new Error('late failure'))
  else resolve(true)
  expect(await restoring).toBe(false)
  expect(pb.historyRestoreReport).toBe(before)
  expect(flash).not.toHaveBeenCalled()
  expect(onApplied).not.toHaveBeenCalled()
  expect(reuse.reuseBusy.value).toBe(false)
  scope.stop()
})

it('keeps a direct restore active when another reuse is blocked during discovery', async () => {
  const { pb, deps, refresh } = setup(), scope = effectScope()
  let resolve!: (value: boolean) => void
  refresh.mockReturnValueOnce(new Promise<boolean>(done => { resolve = done }))
  const reuse = scope.run(() => usePromptHistoryReuse({ ...deps, generationBusy: ref(false), onApplied: vi.fn() }))!
  // Load the lazy controller before starting the asynchronous direct restore.
  await reuse.resumeHistory(entry())
  const restoring = reuse.applyHistory(entry({ engine: 'anima' }))
  await Promise.resolve()
  expect(reuse.reuseBusy.value).toBe(true)
  expect(await reuse.duplicateHistory(entry({ id: 99 }))).toBe(false)
  resolve(true)
  expect(await restoring).toBe(true)
  expect(pb.historyRestoreReport?.title).toContain('12')
  expect(reuse.reuseBusy.value).toBe(false)
  scope.stop()
})


it('preserves untouched reference and variation ownership through an incomplete prompt restore', async () => {
  const { pb, applyHistory } = setup()
  pb.manualTags = new Set(['sitting', 'library', 'explicit_detail'])
  pb.referenceInput = { tags: ['sitting', 'library'] }
  const variation = { context: 'fixture', source: 'fixture', prompt: '', prose: '', tags: [], outfit: [] }
  pb.randomVariation = variation
  await applyHistory({ id: 'legacy-partial', engine: 'sd', character: 'nene', story: 'Restored story' }, true,
    { style: false, camera: false, prompts: true, parameters: false })
  expect(pb.story).toBe('Restored story')
  expect(pb.referenceInput).toEqual({ tags: ['sitting', 'library'] })
  expect(pb.randomVariation).toEqual(variation)
  await applyInterrogateResult(pb, { engine: 'wd14', tags: ['standing', 'forest'] })
  expect(pb.manualTags).toEqual(new Set(['explicit_detail', 'standing', 'forest']))
  expect(pb.referenceInput).toEqual({ tags: ['standing', 'forest'] })
})

it.each(['tags', 'scene'] as const)('clears only replaced-layer provenance when restoring %s', async layer => {
  const { pb, applyHistory } = setup()
  pb.manualTags = new Set(['library'])
  pb.referenceInput = { tags: ['library'] }
  pb.randomVariation = { context: 'fixture', source: 'fixture', prompt: '', prose: '', tags: [], outfit: [] }
  await applyHistory({ id: 'partial', engine: 'sd', character: 'nene',
    ...(layer === 'tags' ? { manual_tags: ['historical_detail'] } : { scene: null }) }, true,
    { style: false, camera: false, prompts: true, parameters: false })
  expect(pb.randomVariation).toBeNull()
  expect(pb.referenceInput).toEqual(layer === 'tags' ? null : { tags: ['library'] })
  expect([...pb.manualTags]).toEqual(layer === 'tags' ? ['historical_detail'] : ['library'])
})


it('reports scene-only reuse and retires same-scene clothing before accepting saved tags', async () => {
  const { pb, applyHistory, flash } = setup()
  const scene = { id: 'same-scene', char: 'nene', title: 'Room', story: 'Scene story', rating: 'ALL', prompt: 'indoors' }
  useSceneStore().scenes = [scene]
  pb.loadScene(scene)
  const selection = { style: false, camera: false, prompts: true, parameters: false }
  const setOverlay = () => {
    pb.manualTags = new Set(['jacket', 'explicit_detail', 'library'])
    pb.referenceInput = { tags: ['library'] }
    pb.randomVariation = { context: 'fixture', source: 'fixture', prompt: '', prose: '', tags: [], outfit: ['jacket'] }
  }
  setOverlay()
  expect(await applyHistory({ id: 'scene-only', character: 'nene', scene: scene.id }, true, selection)).toBe(true)
  expect(pb.randomVariation).toBeNull()
  expect(pb.manualTags).toEqual(new Set(['explicit_detail', 'library']))
  expect(pb.referenceInput).toEqual({ tags: ['library'] })
  expect(flash.mock.lastCall?.[0]).toContain('已沿用')
  setOverlay()
  expect(await applyHistory({ id: 'saved-tags', character: 'nene', scene: scene.id, manual_tags: ['jacket'] }, true, selection)).toBe(true)
  expect(pb.manualTags).toEqual(new Set(['jacket']))
  expect(await applyHistory({ id: 'clear-scene', character: 'nene', scene: null }, true, selection)).toBe(true)
  pb.setPopularSubject('fixture', 'daily', 'previous')
  expect(await applyHistory({ id: 'clear-blueprint', subject: 'popular', characterId: 'fixture', outfitId: 'daily', blueprintId: null }, true, selection)).toBe(true)
  expect(pb.subject).toMatchObject({ blueprintId: null })
  expect(await applyHistory({ id: 'unsupported', character: 'natsume', scene: null }, true, selection)).toBe(false)
})
