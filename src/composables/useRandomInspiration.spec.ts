import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { effectScope, ref } from 'vue'
import { usePopularPromptAssembly } from './prompt/usePopularPromptAssembly'
import { usePromptAssembly } from './prompt/usePromptAssembly'
import type { PopularCharacter } from '@/types/character'
import { usePromptBuilderStore } from '@/stores/promptBuilderStore'
import { useSceneStore } from '@/stores/sceneStore'
import { useRandomInspiration } from './useRandomInspiration'

let scope = effectScope()
beforeEach(() => {
  setActivePinia(createPinia())
  scope = effectScope()
  useSceneStore().tags = [{ en: 'park', cn: '公园', cat: 'Scene' }]
  usePromptBuilderStore().dataReady = true
})
afterEach(() => { scope.stop(); vi.restoreAllMocks() })
const setup = () => scope.run(() => useRandomInspiration())!

it('real store/caller reaches the default artist pool without loading the full catalog', () => {
  const random = setup()
  const pb = usePromptBuilderStore()
  vi.spyOn(Math, 'random').mockReturnValue(0)
  expect(random.roll()).toBe(true)
  expect(pb.artistStyleIds).toEqual([])
  random.includeArtists.value = true
  expect(random.roll()).toBe(true)
  expect(pb.artistStyleIds).toEqual(['mika_pikazo'])
})

it('rerolls replace generated artists while retaining manual choices and the two-artist limit', () => {
  const random = setup()
  const pb = usePromptBuilderStore()
  pb.setArtistStyleIds(['rella'])
  random.includeArtists.value = true
  const rng = vi.spyOn(Math, 'random').mockReturnValue(0)
  random.roll()
  expect(pb.artistStyleIds).toEqual(['rella', 'nardack'])
  rng.mockReturnValue(0.4)
  random.roll()
  expect(pb.artistStyleIds[0]).toBe('rella')
  expect(pb.artistStyleIds).toHaveLength(2)
  expect(pb.artistStyleIds[1]).not.toBe('nardack')
  random.includeArtists.value = false
  random.roll()
  expect(pb.artistStyleIds).toEqual(['rella'])
})

it('manual picker changes become user-owned rather than being silently replaced', () => {
  const random = setup()
  const pb = usePromptBuilderStore()
  random.includeArtists.value = true
  vi.spyOn(Math, 'random').mockReturnValue(0)
  random.roll()
  pb.setArtistStyleIds(['kantoku', 'anmi'])
  random.roll()
  expect(pb.artistStyleIds).toEqual(['kantoku', 'anmi'])
})

it('undo restores all style fields and generated-artist ownership', () => {
  const random = setup()
  const pb = usePromptBuilderStore()
  const before = pb.snapshotStyleLayers()
  random.includeArtists.value = true
  const rng = vi.spyOn(Math, 'random').mockReturnValue(0)
  random.roll()
  const first = pb.snapshotStyleLayers()
  rng.mockReturnValue(0.4)
  random.roll()
  expect(random.undo()).toBe(true)
  expect(pb.snapshotStyleLayers()).toEqual(first)
  random.includeArtists.value = false
  random.roll()
  expect(pb.artistStyleIds).toEqual(before.artistStyleIds)
  expect(random.undo()).toBe(true)
  expect(pb.snapshotStyleLayers()).toEqual(first)
  expect(random.undo()).toBe(false)
})

it.each(['character', 'scene', 'popular', 'project'])('invalidates undo on %s context changes', context => {
  const random = setup()
  const pb = usePromptBuilderStore()
  random.roll()
  expect(random.hasUndo.value).not.toBeNull()
  if (context === 'character') pb.setChar('natsume')
  if (context === 'scene') pb.sceneId = 'new-scene'
  if (context === 'popular') pb.setPopularSubject('other', 'outfit', null)
  if (context === 'project') pb.projectId = 'new-project'
  const state = pb.snapshotStyleLayers()
  expect(random.hasUndo.value).toBeNull()
  expect(random.undo()).toBe(false)
  expect(pb.snapshotStyleLayers()).toEqual(state)
})

it('missing data or missing popular identity causes no state mutation', () => {
  const random = setup()
  const pb = usePromptBuilderStore()
  pb.dataReady = false
  const before = pb.snapshotStyleLayers()
  expect(random.roll()).toBe(false)
  expect(pb.snapshotStyleLayers()).toEqual(before)
  pb.dataReady = true
  pb.setPopularSubject('missing', 'missing', null)
  const popular = pb.snapshotStyleLayers()
  expect(random.roll()).toBe(false)
  expect(pb.snapshotStyleLayers()).toEqual(popular)
})

it('undo restores the recipe exported for the restored inspiration', () => {
  const random = setup()
  random.roll(41)
  random.roll(42)
  expect(random.lastRecipe.value?.seed).toBe(42)
  random.undo()
  expect(random.lastRecipe.value?.seed).toBe(41)
})

it.each(['tags', 'artists', 'shot', 'emotion'])('manual %s edits invalidate previews and the old export', field => {
  const random = setup()
  const pb = usePromptBuilderStore()
  random.roll(41)
  random.prepareCandidates(3, 42)
  if (field === 'tags') pb.manualTags.add('hand_written_detail')
  if (field === 'artists') pb.setArtistStyleIds(['rella'])
  if (field === 'shot') pb.selections.shot = 'custom-shot'
  if (field === 'emotion') pb.selections.emotion.push('custom-emotion')
  const edited = pb.snapshotStyleLayers()
  expect(random.candidates.value).toEqual([])
  expect(random.lastRecipe.value).toBeNull()
  expect(random.applyCandidate(0)).toBe(false)
  expect(pb.snapshotStyleLayers()).toEqual(edited)
})

it('failed previews clear previous candidates without changing current style or undo', () => {
  const random = setup()
  const pb = usePromptBuilderStore()
  random.roll(41)
  const before = pb.snapshotStyleLayers()
  const undo = random.hasUndo.value
  expect(random.prepareCandidates(3, NaN)).toBe(false)
  expect(random.candidates.value).toEqual([])
  expect(random.applyCandidate(0)).toBe(false)
  expect(pb.snapshotStyleLayers()).toEqual(before)
  expect(random.hasUndo.value).toEqual(undo)
})

it('reapplying the same candidate preserves undo and switching candidates still works', () => {
  const random = setup()
  const pb = usePromptBuilderStore()
  const before = pb.snapshotStyleLayers()
  random.prepareCandidates(3, 41)
  random.applyCandidate(0)
  const first = pb.snapshotStyleLayers()
  random.applyCandidate(0)
  expect(random.hasUndo.value).toEqual(before)
  random.applyCandidate(1)
  expect(random.lastRecipe.value?.seed).toBe(42)
  expect(random.undo()).toBe(true)
  expect(pb.snapshotStyleLayers()).toEqual(first)
  expect(random.candidates.value).toEqual([])
})

it('editing applied emotions does not mutate the preview draw', () => {
  const random = setup()
  random.prepareCandidates(1, 41)
  const candidate = random.candidates.value[0]
  const original = [...candidate.draw.emotions]
  random.applyCandidate(0)
  usePromptBuilderStore().selections.emotion.push('manual')
  expect(candidate.draw.emotions).toEqual(original)
})

it.each(['artists', 'catalog', 'ready', 'outfit'])('invalidates previews after %s context changes', field => {
  const random = setup()
  const pb = usePromptBuilderStore()
  random.prepareCandidates(3, 41)
  if (field === 'artists') random.includeArtists.value = true
  if (field === 'catalog') useSceneStore().tags.push({ en: 'library', cn: '图书馆', cat: 'Scene' })
  if (field === 'ready') pb.dataReady = false
  if (field === 'outfit') pb.setOutfitOverride(['dress'], 'test')
  expect(random.candidates.value).toEqual([])
  expect(random.applyCandidate(0)).toBe(false)
})

it('free popular mode uses a real wardrobe variation while protecting identity and undo', () => {
  const character: PopularCharacter = {
    id: 'fixture', displayName: 'Fixture', originalName: 'Fixture', franchise: 'Fixture', aliases: [],
    identityProse: 'An adult woman with black hair and blue eyes', identityTokens: ['1girl', 'black_hair', 'blue_eyes'],
    exactTokens: [], exactPrefixes: [], recommendedEngine: 'anima', supportedEngines: ['anima', 'krea2'], adultEligibility: 'adult',
    outfits: [{ id: 'default', name: 'Default', tokens: ['jacket'], prose: 'a jacket', default: true }],
  }
  useSceneStore().popularCharacters = [character]
  useSceneStore().tags = [{ en: 'white_hair', cn: '白发', cat: 'Appearance' }, { en: 'jacket', cn: '夹克', cat: 'Clothing' }, { en: 'park', cn: '公园', cat: 'Scene' }]
  const pb = usePromptBuilderStore(); pb.setPopularSubject(character.id, 'default')
  const random = setup(); const before = pb.snapshotStyleLayers()
  expect(random.roll(2)).toBe(true)
  expect(pb.randomVariation?.outfit).toContain('jacket')
  const assembly = scope.run(() => usePopularPromptAssembly(pb, ref('anima'), ref('fixture-model')))!
  expect(assembly.positivePrompt.value).toContain('black hair')
  expect(assembly.positivePrompt.value).not.toContain('white hair')
  expect(assembly.positivePrompt.value).toContain('jacket')
  expect(random.undo()).toBe(true); expect(pb.snapshotStyleLayers()).toEqual(before)
  random.roll(2); pb.setOutfitOverride(['coat'], null)
  expect(pb.manualTags.has('jacket')).toBe(false)
  expect(assembly.positivePrompt.value).toContain('coat')
  expect(assembly.positivePrompt.value).not.toContain('jacket')
})

it('scene variation follows manual camera/caption edits and clears on same-scene reload', () => {
  const scene = { id: 'fixture', char: 'nene', title: 'Classroom', story: 'Original', rating: 'ALL',
    prompt: 'indoors, classroom, night, school_uniform', tags: ['classroom', 'night', 'school_uniform'],
    animaCaption: 'A close-up of an adult woman in a classroom, wearing a school uniform.', camera: 'close', lighting: 'moon' }
  useSceneStore().scenes = [scene]
  useSceneStore().tags = [{ en: 'beach', cn: '海滩', cat: 'Scene' }, { en: 'jacket', cn: '夹克', cat: 'Clothing' }, { en: 'school_uniform', cn: '制服', cat: 'Clothing' }]
  const pb = usePromptBuilderStore(); pb.loadScene(scene)
  const random = setup(); expect(random.roll(5)).toBe(true)
  expect(pb.manualTags.has('beach')).toBe(false)
  const assembly = scope.run(() => usePromptAssembly(pb, ref(''), ref('anima'), ref('fixture'), ref('')))!
  expect(assembly.positivePrompt.value).toContain('classroom')
  pb.setShot('wide')
  expect(assembly.positivePrompt.value).toContain('A wide shot of an adult woman')
  expect(assembly.positivePrompt.value).not.toContain('A close-up')
  pb.visualDescription = 'She holds an open book.'
  expect(assembly.positivePrompt.value).toContain('She holds an open book.')
  expect(assembly.positivePrompt.value).not.toContain('of an adult woman in a classroom')
  pb.loadScene(scene)
  expect(pb.randomVariation).toBeNull()
})

it('does not apply a popular wardrobe from a different source context', () => {
  const pb = usePromptBuilderStore()
  const random = setup(); random.roll(4)
  const variation = pb.randomVariation!
  pb.setPopularSubject('other', 'outfit')
  expect(pb.randomVariation).toBeNull()
  pb.randomVariation = variation
  const state = scope.run(() => usePopularPromptAssembly(pb, ref('anima'), ref('fixture')))!
  expect(state.positivePrompt.value).toBe('')
})

it('random replacements release reference tag ownership and undo restores it', () => {
  const pb = usePromptBuilderStore()
  pb.manualTags = new Set(['park'])
  pb.referenceInput = { tags: ['park'] }
  const random = setup()
  expect(random.roll(42)).toBe(true)
  expect(pb.manualTags.has('park')).toBe(true)
  expect(pb.referenceInput).toBeNull()
  expect(random.undo()).toBe(true)
  expect(pb.manualTags).toEqual(new Set(['park']))
  expect(pb.referenceInput).toEqual({ tags: ['park'] })
  random.roll(42)
  vi.spyOn(useSceneStore(), 'loadBlueprintCharacter').mockResolvedValue(undefined)
  pb.setPopularSubject('fixture', 'default')
  expect(pb.manualTags.has('park')).toBe(true)
})
