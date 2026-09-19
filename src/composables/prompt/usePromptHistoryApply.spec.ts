import { beforeEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import { usePromptBuilderStore, type HistoryEntry } from '@/stores/promptBuilderStore'
import { useSceneStore } from '@/stores/sceneStore'
import type { AnimaGenerationState } from '@/types/anima'
import { usePromptHistoryApply } from './usePromptHistoryApply'

beforeEach(() => setActivePinia(createPinia()))
function setup() {
  const pb = usePromptBuilderStore()
  const state = ref({ phase: 'idle', family: 'anima', models: [], loras: [], online: true, modelId: 'old', loraId: '', styleLoraId: '', width: 832, height: 1216, steps: 20, cfg: 5 } as unknown as AnimaGenerationState)
  const flash = vi.spyOn(pb, 'flash')
  const refresh = vi.fn(async () => {})
  const api = usePromptHistoryApply({ pb, animaState: state, patchAnimaState: patch => { Object.assign(state.value, patch) }, clearAnimaResult: vi.fn(), refreshAnimaBackend: refresh, setDrawEngine: vi.fn(), resetBlueprintRotation: vi.fn(), sdSize: ref('832x1216') })
  return { pb, state, flash, refresh, ...api }
}
const entry = (overrides: Partial<HistoryEntry> = {}) => ({ id: 12, engine: 'sd', character: 'nene', manual_tags: ['dof'], emotion: ['calm'], shot: 'wide', lighting: 'moon', composition: 'rule3', colorMood: 'warmth', story: 'Saved story', seed: -1, cfg: 0, steps: 25, sampler: 'Euler', scheduler: '', size: '832x1216', project: 'saved-project', ...overrides } as HistoryEntry)

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
it('reports backend model and style fallback after discovery completes', async () => {
  const { pb, state, refresh, applyHistory } = setup()
  refresh.mockImplementation(async () => { state.value.modelId = 'available'; state.value.styleLoraId = ''; state.value.width = 1024 })
  await applyHistory(entry({ engine: 'krea2', model: 'missing', styleLoraId: 'old-style' }))
  expect(pb.historyRestoreReport?.notes.join(';')).toContain('missing → available')
  expect(pb.historyRestoreReport?.notes.join(';')).toContain('old-style → 不可用')
  expect(pb.historyRestoreReport?.notes.join(';')).toContain('832 → 1024')
})
it('unknown engines leave the current draft intact', async () => {
  const { pb, applyHistory } = setup()
  pb.story = 'Keep me'
  await applyHistory(entry({ engine: 'unknown' as HistoryEntry['engine'] }))
  expect(pb.story).toBe('Keep me')
})
