import { beforeEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import { usePromptBuilderStore } from '@/stores/promptBuilderStore'
import { useSceneStore } from '@/stores/sceneStore'
import type { PopularCharacter, SceneBlueprint } from '@/utils/popularContent'
import { usePopularPromptAssembly } from '@/composables/prompt/usePopularPromptAssembly'
import { captureResultContext, historyFromResultContext } from '@/utils/resultContext'
import { useDirectorPopular, type UseDirectorPopularInput } from './useDirectorPopular'

const characters: PopularCharacter[] = ['black', 'brown', 'silver'].map((color, index) => ({
  id: `fixture-${index}`, displayName: `Fixture ${index}`, originalName: `Fixture ${index}`, franchise: 'Fixture',
  aliases: [], identityProse: `An adult woman with ${color} hair and blue eyes`,
  identityTokens: ['1girl', 'solo', `${color}_hair`, 'blue_eyes'], exactTokens: [`fixture_${index}`], exactPrefixes: [],
  recommendedEngine: 'anima', supportedEngines: ['anima', 'krea2'], adultEligibility: 'adult',
  outfits: [
    { id: 'default', name: 'Default', tokens: ['school_uniform'], prose: 'a school uniform', default: true },
    { id: 'coat', name: 'Coat', tokens: ['winter_coat'], prose: 'a winter coat' },
  ],
}))
const blueprint: SceneBlueprint = {
  id: 'fixture-scene', title: 'Library', category: 'daily', description: 'Reading at a library',
  location: 'library', action: 'reading', timeOfDay: 'day', lighting: 'window light', camera: 'medium shot', mood: 'calm',
  sceneTags: [], promptProse: 'Reading a book at a library.', promptTokens: ['library', 'reading'], negativeTokens: [],
  recommendedSize: '832x1216', adult: false,
}

function setup() {
  const catalog = useSceneStore()
  catalog.popularCharacters = characters
  catalog.sceneBlueprints = [blueprint]
  const pb = usePromptBuilderStore()
  pb.directorMode = 'pro'
  pb.setPopularSubject(characters[0].id, 'default')
  pb.setOutfitOverride(['kimono'], '校服/水手服')
  pb.manualTags = new Set(['sitting', 'park', 'paper_lantern'])
  pb.referenceInput = { tags: ['sitting', 'park'] }
  pb.visualDescription = 'Holding a paper lantern beside a tree.'
  pb.setShot('wide'); pb.setLighting('golden'); pb.setComposition('rule3')
  const input = {
    pb, drawEngine: ref('anima'), animaState: ref({ modelId: 'fixture-model', loraId: '', models: [] }), generationBusy: ref(false),
    sd: { models: ref([]), checkpoint: ref('') }, setDrawEngine: vi.fn(), applyModel: vi.fn(), patchAnimaState: vi.fn(),
    refreshAnimaBackend: vi.fn().mockResolvedValue(undefined), applyRecommendedSize: vi.fn(), flash: vi.fn(), sdSize: ref('832x1216'),
  } as unknown as UseDirectorPopularInput
  return { pb, input, flow: useDirectorPopular(input) }
}

beforeEach(() => {
  setActivePinia(createPinia()); localStorage.clear()
  vi.spyOn(useSceneStore(), 'loadBlueprintCharacter').mockResolvedValue(undefined)
})

it.each(['anima', 'krea2'] as const)('replaces only identity across consecutive character switches in %s', engine => {
  const { pb, flow } = setup()
  const assembly = usePopularPromptAssembly(pb, ref(engine), ref('fixture-model'))
  for (const character of characters.slice(1)) {
    flow.selectPopularCharacter(character)
    expect(pb.outfitOverride?.tokens).toEqual(['kimono'])
    expect(pb.referenceInput).toEqual({ tags: ['sitting', 'park'] })
    expect(pb.visualDescription).toBe('Holding a paper lantern beside a tree.')
    expect(pb.selections).toMatchObject({ shot: 'wide', lighting: 'golden', composition: 'rule3' })
    const prompt = assembly.positivePrompt.value
    expect(prompt).toContain('kimono')
    expect(prompt).toContain('sitting')
    expect(prompt).toContain('park')
    expect(prompt).toMatch(new RegExp(character.identityTokens[2].replace('_', '[_ ]')))
    expect(prompt).not.toMatch(/black[_ ]hair|school[_ ]uniform/)
  }
  pb.$dispose()
})

it('keeps legacy reference outfits without source markers, while explicit outfit and scene choices take effect', () => {
  const { pb, flow } = setup()
  pb.referenceInput = null
  flow.selectPopularCharacter(characters[1])
  expect(pb.outfitOverride?.tokens).toEqual(['kimono'])
  pb.referenceInput = { tags: ['sitting', 'park'] }
  flow.selectPopularOutfit('coat')
  expect(pb.outfitOverride).toBeNull()
  expect(pb.manualTags).toEqual(new Set(['sitting', 'park', 'paper_lantern']))
  expect(pb.referenceInput).toEqual({ tags: ['sitting', 'park'] })
  flow.selectBlueprint(blueprint)
  expect(pb.referenceInput).toBeNull()
  expect(pb.manualTags).toEqual(new Set(['paper_lantern']))
  expect(pb.subject).toMatchObject({ blueprintId: blueprint.id, outfitId: 'coat' })
  pb.$dispose()
})

it('honors explicit scene reset and does not resurrect reference tags afterward', () => {
  const { pb, flow } = setup()
  pb.clearScene()
  flow.selectPopularCharacter(characters[1])
  expect(pb.outfitOverride).toBeNull()
  expect(pb.referenceInput).toBeNull()
  expect(pb.manualTags.size).toBe(0)
  expect(pb.visualDescription).toBe('')
  pb.$dispose()
})

it('does not replay an older generated recipe over newer reference layers during draft restoration', () => {
  const { pb, flow, input } = setup()
  useSceneStore().sceneBlueprints = [{ ...blueprint, generatedRecipe: {
    version: 1, engine: 'anima', prompt: 'Reading at a library.', negative: '', parameters: { shot: 'close' },
  } }]
  pb.setPopularBlueprint(blueprint.id)
  flow.restorePopularDraft()
  expect(pb.referenceInput).toEqual({ tags: ['sitting', 'park'] })
  expect(pb.outfitOverride?.tokens).toEqual(['kimono'])
  expect(pb.visualDescription).toBe('Holding a paper lantern beside a tree.')
  expect(pb.selections.shot).toBe('wide')
  expect(input.setDrawEngine).not.toHaveBeenCalled()
  expect(input.refreshAnimaBackend).toHaveBeenCalled()
  pb.$dispose()
})

it('clears unsupported new scene controls and releases inherited settings when selecting another character', () => {
  const { pb, flow } = setup()
  flow.selectBlueprint(blueprint)
  expect(pb.colorMood).toBeNull()
  expect(pb.selections.lighting).toBe('window')
  const next = { ...blueprint, id: 'studio-light', camera: '', lighting: 'cool fluorescent lighting', mood: 'mysterious' }
  useSceneStore().sceneBlueprints.push(next)
  flow.selectBlueprint(next)
  expect(pb.selections).toMatchObject({ shot: null, lighting: null, composition: null })
  expect(pb.colorMood).toBeNull()
  flow.selectPopularCharacter(characters[1])
  expect(pb.subject).toMatchObject({ blueprintId: null })
  expect(pb.colorMood).toBeNull()
  expect(pb.selections).toMatchObject({ shot: null, lighting: null, composition: null })
  expect(historyFromResultContext(captureResultContext(pb))).toMatchObject({
    character: characters[1].id, scene: null, sceneTitle: 'Fixture 1 创作', story: '',
  })
  pb.$dispose()
})

it('keeps director settings edited away from the old blueprint during a character switch', () => {
  const { pb, flow } = setup()
  flow.selectBlueprint(blueprint)
  pb.setStory('My handwritten story')
  pb.setShot('close'); pb.setLighting('moon'); pb.setComposition('center'); pb.setColorMood('warmth')
  flow.selectPopularCharacter(characters[1])
  expect(pb.colorMood).toBe('warmth')
  expect(pb.selections).toMatchObject({ shot: 'close', lighting: 'moon', composition: 'center' })
  expect(captureResultContext(pb).story).toBe('My handwritten story')
  pb.$dispose()
})
