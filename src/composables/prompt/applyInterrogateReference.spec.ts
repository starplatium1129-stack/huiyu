import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import { usePromptBuilderStore } from '@/stores/promptBuilderStore'
import { useSceneStore } from '@/stores/sceneStore'
import type { PopularCharacter } from '@/types/character'
import { applyInterrogateResult } from './applyInterrogateResult'
import { usePopularPromptAssembly } from './usePopularPromptAssembly'
import { usePromptAssembly } from './usePromptAssembly'

const character = (id: string, hair: string): PopularCharacter => ({
  id, displayName: id, originalName: id, franchise: 'Fixture', aliases: [id],
  identityProse: `An adult woman with ${hair.replace('_', ' ')}, wearing a school uniform. She has blue eyes.`,
  identityTokens: ['1girl', 'solo', hair, 'blue_eyes', 'school_uniform'],
  exactTokens: [id, 'school_uniform'], exactPrefixes: [],
  recommendedEngine: 'anima', supportedEngines: ['anima', 'krea2'], adultEligibility: 'adult',
  outfits: [{ id: 'default', name: 'Default', tokens: ['school_uniform'], prose: 'a school uniform', default: true }],
})
const cleanups: Array<() => void> = []
beforeEach(() => {
  setActivePinia(createPinia()); localStorage.clear(); vi.useFakeTimers()
  vi.spyOn(useSceneStore(), 'loadBlueprintCharacter').mockResolvedValue(undefined)
})
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); vi.clearAllTimers(); vi.useRealTimers() })
function fixture() {
  useSceneStore().popularCharacters = [character('fixture_a', 'black_hair'), character('fixture_b', 'silver_hair')]
  const pb = usePromptBuilderStore()
  cleanups.push(() => pb.$dispose())
  pb.setPopularSubject('fixture_a', 'default')
  return pb
}
const extract = (tags: string[], extra = {}) => ({ engine: 'wd14', mode: 'tag', tags, ...extra })

it.each(['anima', 'krea2'] as const)('keeps authored props while director lighting and palette add only their selected effect in %s', async engine => {
  const pb = fixture()
  pb.setColorMood('warmth')
  const assembly = usePopularPromptAssembly(pb, ref(engine), ref('fixture-model'))
  await applyInterrogateResult(pb, extract(['white_coat', 'sitting', 'library']))
  for (const lighting of ['window', 'lantern', 'moon', 'back']) {
    pb.setLighting(lighting)
    const prompt = assembly.positivePrompt.value
    expect(prompt).toContain('orange theme')
    expect(prompt).toContain('warm tones')
    expect(prompt).toMatch(/white[_ ]coat/)
    expect(prompt).toContain('library')
    expect(prompt).not.toMatch(/candle|\blantern\b|\bstars\b|silhouette|sunlight|volumetric/)
  }
  pb.setColorMood('calm')
  pb.setLighting(null)
  expect(assembly.positivePrompt.value).toContain('green theme')
  expect(assembly.positivePrompt.value).toContain('library')
  expect(assembly.positivePrompt.value).not.toMatch(/window[_ ]light/)
  pb.setLighting('window')
  expect(assembly.positivePrompt.value).toMatch(/window[_ ]light/)
  await applyInterrogateResult(pb, extract(['white_coat', 'candle', 'candlelight']))
  expect(pb.referenceInput?.tags).toEqual(['candle', 'candlelight'])
  expect(assembly.positivePrompt.value).toContain('candlelight')
  await applyInterrogateResult(pb, extract(['white_coat', 'park']))
  expect(assembly.positivePrompt.value).toContain('park')
  expect(assembly.positivePrompt.value).not.toMatch(/candle/)
  pb.addManualTag('candle')
  await applyInterrogateResult(pb, extract(['white_coat', 'library']))
  expect(assembly.positivePrompt.value).toContain('candle')
  expect(pb.referenceInput?.tags).toEqual(['library'])
})

it.each(['anima', 'krea2'] as const)('keeps reference clothes and scene while only replacing target identity in %s', async engine => {
  const pb = fixture()
  await applyInterrogateResult(pb, extract(['pink_hair', 'red_eyes', 'fox_ears', 'fixture_a', 'white_coat', 'sitting', 'library', 'from_above']))
  expect(pb.outfitOverride?.tokens).toEqual(['white_coat'])
  expect(pb.manualTags).toEqual(new Set(['sitting', 'library', 'from_above']))
  const assembly = usePopularPromptAssembly(pb, ref(engine), ref('fixture-model'))
  for (const target of ['fixture_b', 'fixture_a', 'fixture_b']) {
    pb.setPopularSubject(target, 'default', null, { preserveReference: true, preserveOutfitOverride: true })
    const prompt = assembly.positivePrompt.value
    expect(prompt).toMatch(/white[_ ]coat/)
    expect(prompt).toContain('library')
    expect(prompt).toContain('sitting')
    expect(prompt).not.toMatch(/pink[_ ]hair|red[_ ]eyes|fox[_ ]ears|school[_ ]uniform/)
    expect(prompt).toMatch(target === 'fixture_b' ? /silver[_ ]hair/ : /black[_ ]hair/)
    expect(prompt).not.toMatch(target === 'fixture_b' ? /black[_ ]hair/ : /silver[_ ]hair/)
  }
})

it('keeps same-family clothing independently of the first target defaults', async () => {
  const pb = fixture()
  await applyInterrogateResult(pb, extract(['school_uniform', 'library']))
  expect(pb.outfitOverride?.tokens).toEqual(['school_uniform'])
  pb.setPopularSubject('fixture_b', 'default', null, { preserveReference: true, preserveOutfitOverride: true })
  expect(pb.outfitOverride?.tokens).toEqual(['school_uniform'])
})

it.each(['anima', 'krea2'] as const)('protects explicit director angle and time when applying a reference in %s', async engine => {
  const pb = fixture()
  pb.setShot('high')
  pb.setLighting('golden')
  await applyInterrogateResult(pb, extract(['pink_hair', 'white_coat', 'sitting', 'library', 'from_below', 'night']))
  const prompt = usePopularPromptAssembly(pb, ref(engine), ref('fixture-model')).positivePrompt.value
  expect(prompt).toMatch(/high[_ ]angle/)
  expect(prompt).toMatch(/golden[_ -]hour/)
  expect(prompt).not.toMatch(/from[_ ]below|night/)
  expect(prompt).toMatch(/black[_ ]hair/)
  expect(prompt).toMatch(/white[_ ]coat/)
  expect(prompt).toContain('sitting')
  expect(prompt).toContain('library')
  expect(pb.referenceInput?.tags).toEqual(['sitting', 'library'])
})

it('lets a reference replace inherited director angle and time with the old studio scene', async () => {
  const pb = usePromptBuilderStore()
  cleanups.push(() => pb.$dispose())
  const scene = { id: 'inherited-director', char: 'nene', title: 'Beach', rating: 'ALL',
    prompt: 'beach, high_angle, golden_hour', tags: [], camera: 'high', lighting: 'golden' }
  useSceneStore().scenes = [scene]
  pb.loadScene(scene)
  await applyInterrogateResult(pb, extract(['white_coat', 'sitting', 'library', 'from_below', 'night']))
  expect(pb.selections.shot).toBeNull()
  expect(pb.selections.lighting).toBeNull()
  expect(pb.referenceInput?.tags).toEqual(['white_coat', 'sitting', 'library', 'from_below', 'night'])
  const prompt = usePromptAssembly(pb, ref(''), ref('anima'), ref('fixture-model'), ref('')).positivePrompt.value
  expect(prompt).toMatch(/from[_ ]below/)
  expect(prompt).toContain('night')
  expect(prompt).not.toMatch(/high[_ ]angle|golden[_ -]hour|beach/)
})

it('preserves explicit manual conflicts and overlapping tags while replacing only prior reference tags', async () => {
  const pb = fixture()
  pb.addManualTag('standing')
  pb.addManualTag('library')
  await applyInterrogateResult(pb, extract(['sitting', 'library', 'sunset']))
  expect(pb.manualTags).toEqual(new Set(['standing', 'library', 'sunset']))
  expect(pb.referenceInput?.tags).toEqual(['sunset'])
  await applyInterrogateResult(pb, extract(['standing', 'forest', 'morning']))
  expect(pb.manualTags).toEqual(new Set(['standing', 'library', 'forest', 'morning']))
  pb.clearReferenceInput()
  expect(pb.manualTags).toEqual(new Set(['standing', 'library']))
})

it('does not import an identity even when the first target leaves its domain empty', async () => {
  const pb = fixture()
  useSceneStore().popularCharacters[0].identityTokens = ['1girl', 'solo']
  await applyInterrogateResult(pb, extract(['aqua_hair', 'heterochromia', 'elf', 'pointy_ears', 'kimono', 'forest']))
  expect(pb.manualTags).toEqual(new Set(['forest']))
  expect(pb.outfitOverride?.tokens).toEqual(['kimono'])
})

it('uses safe structured caption tags without overwriting handwritten prose', async () => {
  const pb = fixture()
  pb.visualDescription = 'Soft light through a window.'
  await applyInterrogateResult(pb, extract(['pink_hair', 'white_coat', 'sitting', 'library'], {
    mode: 'caption', caption: 'A pink-haired woman in a white coat sitting in a library.',
  }))
  expect(pb.visualDescription).toBe('Soft light through a window.')
  expect(pb.manualTags).toEqual(new Set(['sitting', 'library']))
  const previous = pb.snapshotDraft()
  const flash = vi.spyOn(pb, 'flash')
  await applyInterrogateResult(pb, extract([], { mode: 'caption', caption: 'A woman with pink hair in a forest.' }))
  expect(pb.snapshotDraft()).toEqual(previous)
  expect(flash).toHaveBeenCalledWith(expect.stringContaining('未写入'))
})

it('keeps explicit user footwear instead of mixing it with a barefoot reference', async () => {
  const pb = fixture()
  pb.addManualTag('boots')
  await applyInterrogateResult(pb, extract(['barefoot', 'library']))
  expect(pb.manualTags).toEqual(new Set(['boots', 'library']))
  expect(pb.referenceInput?.tags).toEqual(['library'])
})

it('replaces inherited blueprint prose with the reference scene without losing explicit manual edits', async () => {
  const pb = fixture()
  useSceneStore().sceneBlueprints = [{
    id: 'old-scene', title: 'Beach', category: 'daily', description: 'Standing on a beach',
    location: 'beach', action: 'standing', timeOfDay: 'day', lighting: 'sunlight', camera: 'medium shot', mood: 'calm',
    sceneTags: [], promptProse: 'Standing on a beach.', promptTokens: ['beach', 'standing'], negativeTokens: [],
    recommendedSize: '832x1216', adult: false,
  }]
  pb.setPopularSubject('fixture_a', 'default', 'old-scene')
  pb.setStory('Standing on a beach')
  pb.addManualTag('paper_lantern')
  pb.setShot('wide')
  await applyInterrogateResult(pb, extract(['white_coat', 'sitting', 'library']))
  expect(pb.subject).toMatchObject({ blueprintId: null })
  expect(pb.story).toBe('')
  expect(pb.selections.shot).toBe('wide')
  expect(pb.manualTags.has('paper_lantern')).toBe(true)
  const assembly = usePopularPromptAssembly(pb, ref('krea2'), ref('fixture-model'))
  expect(assembly.positivePrompt.value).toContain('library')
  expect(assembly.positivePrompt.value).toContain('sitting')
  expect(assembly.positivePrompt.value).not.toMatch(/beach|standing/)
})

it.each(['anima', 'krea2'] as const)('keeps a reference background color without automatic styling or character poses in %s', async engine => {
  const pb = fixture()
  const target = useSceneStore().popularCharacters[0]
  target.identityProse = 'Fixture A from Fixture, a woman with black hair and blue eyes, an expressionless peace-sign pose, and a warm sunset backdrop.'
  target.identityTokens.push('expressionless', 'standing', 'full_body', 'pink_background')
  await applyInterrogateResult(pb, extract(['white_coat', 'sitting', 'blue_background', 'simple_background', 'sad']))
  const assembly = usePopularPromptAssembly(pb, ref(engine), ref('fixture-model'))
  expect(assembly.positivePrompt.value).toMatch(/blue[_ ]background/)
  expect(assembly.positivePrompt.value).toContain('sitting')
  expect(assembly.positivePrompt.value).toContain('sad')
  expect(assembly.positivePrompt.value).toMatch(/black[_ ]hair/)
  expect(assembly.positivePrompt.value).toMatch(/blue[_ ]eyes/)
  expect(assembly.positivePrompt.value).not.toMatch(/pink[_ ]background|standing|full[_ ]body|peace-sign|expressionless|warm sunset|saturated colors|cel shading|layered background|cinematic atmosphere|visual novel event CG/)
  expect(assembly.structuredPlan.value?.style).toEqual([])
})

it.each(['anima', 'krea2'] as const)('replaces an inherited studio scene with the reference while retaining target identity in %s', async engine => {
  const pb = usePromptBuilderStore()
  cleanups.push(() => pb.$dispose())
  const scene = {
    id: 'old-studio-scene', char: 'nene', title: 'Beach', story: 'Original scene story', rating: 'ALL',
    prompt: 'beach, standing, school_uniform, golden_hour, medium_shot',
    animaCaption: 'Standing on a beach, wearing a school uniform.', tags: [],
    camera: 'medium', lighting: 'golden', composition: 'center', colorMood: 'joy',
  }
  useSceneStore().scenes = [scene]
  pb.loadScene(scene)
  const original = pb.snapshotDraft()
  await applyInterrogateResult(pb, extract(['pink_hair', 'red_eyes']))
  expect(pb.snapshotDraft()).toEqual(original)
  await applyInterrogateResult(pb, extract(['pink_hair', 'red_eyes', 'white_coat', 'sitting', 'library', 'from_above']))
  const assembly = usePromptAssembly(pb, ref(''), ref(engine), ref('fixture-model'), ref(''))
  const prompt = assembly.positivePrompt.value
  expect(prompt).not.toMatch(/beach|standing|school[_ ]uniform|golden[_ ]hour|medium[_ -]shot|pink[_ ]hair(?![_ ]ribbons)|red[_ ]eyes/)
  expect(prompt).toMatch(/ayachi[_ ]nene/i)
  expect(prompt).toMatch(/white[_ ]hair/)
  expect(prompt).toMatch(/purple[_ ]eyes/)
  expect(prompt).toMatch(/white[_ ]coat/)
  expect(prompt).toContain('sitting')
  expect(prompt).toContain('library')
  expect(pb.sceneId).toBeNull()
  expect(pb.selections).toEqual({ emotion: [], shot: null, lighting: null, composition: null })
  expect(pb.colorMood).toBeNull()
  expect(pb.story).toBe('')
})

it('retains explicit studio edits when the reference replaces the inherited scene', async () => {
  const pb = usePromptBuilderStore()
  cleanups.push(() => pb.$dispose())
  const scene = { id: 'old-studio-scene', char: 'natsume', title: 'Beach', story: 'Original', rating: 'ALL',
    prompt: 'beach, standing, school_uniform', tags: [], camera: 'medium', lighting: 'golden', composition: 'center', colorMood: 'joy' }
  useSceneStore().scenes = [scene]
  pb.loadScene(scene)
  pb.setShot('wide'); pb.setLighting('overcast'); pb.setComposition('rule3'); pb.setColorMood('sad')
  pb.selections.emotion = ['serious']
  pb.setStory('My handwritten story')
  pb.visualDescription = 'She holds an open book.'
  pb.addManualTag('paper_lantern')
  pb.sdParams.cfg = 3.5; pb.markParamTouched('cfg')
  await applyInterrogateResult(pb, extract(['white_coat', 'sitting', 'library']))
  expect(pb.sceneId).toBeNull()
  expect(pb.char).toBe('natsume')
  expect(pb.selections).toEqual({ emotion: ['serious'], shot: 'wide', lighting: 'overcast', composition: 'rule3' })
  expect(pb.colorMood).toBe('sad')
  expect(pb.story).toBe('My handwritten story')
  expect(pb.visualDescription).toBe('She holds an open book.')
  expect(pb.manualTags).toEqual(new Set(['paper_lantern', 'white_coat', 'sitting', 'library']))
  expect(pb.referenceInput?.tags).toEqual(['white_coat', 'sitting', 'library'])
  expect(pb.sdParams.cfg).toBe(3.5)
  expect(pb.sdParamsTouched.has('cfg')).toBe(true)
})
