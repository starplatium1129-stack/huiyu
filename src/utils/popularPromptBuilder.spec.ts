import { expect, it } from 'vitest'
import type { PopularCharacter } from '../types/character'
import type { SceneBlueprint } from '../types/sceneBlueprint'
import { buildPopularPromptPlan } from './popularPromptBuilder'
import { resolveStyleRecipe, type KreaStyleRecipe } from '../config/kreaStyleRecipes'

const character: PopularCharacter = {
  id: 'fixture', displayName: 'Fixture', originalName: 'Fixture', franchise: 'Fixture', aliases: [],
  identityProse: 'An adult woman with black hair and blue eyes',
  identityTokens: ['1girl', 'black_hair'], exactTokens: ['hair_ribbon'], exactPrefixes: [],
  recommendedEngine: 'anima', supportedEngines: ['anima', 'krea2'], adultEligibility: 'adult',
  outfits: [
    { id: 'red', name: 'Red', default: true, tokens: ['red_coat', 'black_hair', 'hair_ribbon'], prose: 'a red coat' },
    { id: 'blue', name: 'Blue', default: false, tokens: ['blue_coat'], prose: 'a blue coat' },
  ],
}
const blueprint: SceneBlueprint = {
  id: 'fixture', characterId: 'fixture', title: 'Book', category: 'daily', description: '',
  location: 'garden', action: 'holding a book', timeOfDay: '', lighting: '', camera: '', mood: '',
  sceneTags: [], promptTokens: ['red coat', 'black_hair', 'hair_ribbon', 'holding_a_coat', 'garden'],
  promptProse: 'She holds a book beside a garden bench.', negativeTokens: [], recommendedSize: '832x1216', adult: false,
}

it('removes only known source outfit tokens for reference replacement or a different selected outfit', () => {
  const before = JSON.stringify({ character, blueprint })
  for (const options of [
    { outfit: character.outfits[0], outfitOverride: ['blue_coat'] },
    { outfit: character.outfits[1] },
  ]) {
    const result = buildPopularPromptPlan({ character, blueprint, engine: 'anima', ...options })!
    expect(result.plan.sceneVisualFragments).toEqual(['black_hair', 'hair_ribbon', 'holding_a_coat', 'garden'])
    const tags = result.prompt.split('\n')[0]
    expect(tags).toContain('blue coat')
    expect(tags).not.toContain('red coat')
    expect(result.plan.sceneProse).toBe(blueprint.promptProse)
  }
  expect(JSON.stringify({ character, blueprint })).toBe(before)
})

it('keeps unchanged outfit selection and unknown source bindings, and respects an explicit source outfit', () => {
  const build = (scene: SceneBlueprint, outfit = character.outfits[0]) => buildPopularPromptPlan({ character, blueprint: scene, outfit, engine: 'anima' })!
  expect(build(blueprint).plan.sceneVisualFragments).toEqual(blueprint.promptTokens)
  expect(build({ ...blueprint, outfitId: 'missing' }, character.outfits[1]).plan.sceneVisualFragments).toEqual(blueprint.promptTokens)
  const explicit = { ...blueprint, outfitId: 'blue', promptTokens: ['blue_coat', 'garden'] }
  expect(build(explicit).plan.sceneVisualFragments).toEqual(['garden'])
})

// Compiler contracts formerly tied to Raiden's changing catalogue prose.
it('retains independent identity, outfit, scene and user direction without leaking metadata', () => {
  const scene = { ...blueprint, description: '这是故事、台词和心理活动：ayachi_nene',
    sceneTags: ['official_cg', 'visual_audited', 'nene_school_uniform'],
    promptTokens: ['garden', 'holding_book'], negativeTokens: ['neon'] }
  for (const engine of ['anima', 'krea2'] as const) {
    for (const visualDescription of ['', 'She lifts a bouquet beside the book.']) {
      const result = buildPopularPromptPlan({ character, outfit: character.outfits[0], blueprint: scene, engine,
        visualDescription, palette: ['pink theme', 'warm light'],
        style: engine === 'krea2' ? { lead: 'A quiet ink illustration', medium: 'ink illustration' } : null })!
      expect(result).not.toBeNull()
      expect(result.prompt).toContain('An adult woman with black hair and blue eyes')
      expect(result.prompt).toContain('a red coat')
      expect(result.prompt).toContain('She holds a book beside a garden bench')
      expect(result.prompt).toContain('pink theme')
      expect(result.prompt).toContain('warm light')
      if (visualDescription) expect(result.prompt).toContain('bouquet')
      expect(result.prompt + result.negative).not.toMatch(/ayachi_nene|shiki_natsume|nene_|natsume_|<lora:|official_cg|visual_audited|这是故事|台词|心理活动/)
      if (engine === 'anima') {
        expect(result.prompt).toContain('hair_ribbon')
        expect(result.prompt).toContain('garden')
        expect(result.negative).toContain('neon')
      } else {
        expect(result.negative).toBe('')
        expect(result.prompt.startsWith('A quiet ink illustration')).toBe(true)
        expect(result.prompt.match(/a red coat/g)).toHaveLength(1)
        expect(result.prompt).not.toMatch(/In this image|The image shows|Scene details:|Composition and lighting|[a-z]+_[a-z]+|,\s*\w+,\s*\w+,\s*\w+,\s*$/i)
        expect(result.prompt).not.toMatch(/completely deserted|not a single other person|no commuters/i)
        expect(result.prompt.trim().endsWith('.')).toBe(true)
      }
    }
  }
})

it('rejects explicit restricted style requests and build-layer bypasses using neutral fixtures', () => {
  const recipe: KreaStyleRecipe = { id: 'fixture_restricted', name: 'Restricted fixture',
    lead: 'A neutral charcoal figure study', medium: 'charcoal drawing', adult: true }
  const restricted = { ...blueprint, adult: true, kreaStyleHint: recipe.id }
  for (const [adultEligibility, adultEnabled] of [
    ['underage', true], ['unknown', true], ['adult', false], ['adult', undefined],
  ] as const) {
    const subject = { ...character, adultEligibility }
    expect(resolveStyleRecipe([recipe], 'krea2', restricted, null, subject, { adultEnabled })).toBeNull()
    expect(buildPopularPromptPlan({ character: subject, outfit: subject.outfits[0], blueprint: restricted,
      engine: 'krea2', adultEnabled, style: recipe })).toBeNull()
  }
  // A permitted adult character still cannot attach a restricted style to a SFW scene.
  expect(buildPopularPromptPlan({ character, outfit: character.outfits[0], blueprint, engine: 'krea2',
    adultEnabled: true, style: recipe })).toBeNull()
  const style = resolveStyleRecipe([recipe], 'krea2', restricted, null, character, { adultEnabled: true })
  expect(style?.adult).toBe(true)
  const allowed = buildPopularPromptPlan({ character, outfit: character.outfits[0], blueprint: restricted,
    engine: 'krea2', adultEnabled: true, style })!
  expect(allowed).not.toBeNull()
  expect(allowed.prompt).toContain('A neutral charcoal figure study')
})
