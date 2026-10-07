import { expect, it } from 'vitest'
import type { PopularCharacter } from '../types/character'
import type { SceneBlueprint } from '../types/sceneBlueprint'
import { buildPopularPromptPlan } from './popularPromptBuilder'

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
