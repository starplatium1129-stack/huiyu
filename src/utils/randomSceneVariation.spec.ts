import { describe, expect, it } from 'vitest'
import { randomCandidates } from './randomPromptRecipe'
import { canVarySceneOutfit, sceneVariationOverlay, type RandomSceneContext } from './randomSceneVariation'
import { hasVariableLight, renderRandomVariationProse } from './randomVariationProse'
import { buildPopularPromptPlan } from './popularPromptBuilder'
import type { PopularCharacter } from '../types/character'

const tags = [
  { en: 'park', cat: 'Scene' }, { en: 'beach', cat: 'Scene' },
  { en: 'standing', cat: 'Action' }, { en: 'sitting', cat: 'Action' },
  { en: 'jacket', cat: 'Clothing' }, { en: 'coat', cat: 'Clothing' },
  { en: 'school_uniform', cat: 'Clothing' },
  { en: 'white_hair', cat: 'Appearance' }, { en: 'purple_eyes', cat: 'Appearance' },
  { en: 'cat_ears', cat: 'Appearance' }, { en: 'fox_tail', cat: 'Clothing' },
  { en: 'hair_bun', cat: 'Appearance' }, { en: 'sunbeam', cat: 'Appearance' },
]
const character: PopularCharacter = {
  id: 'fixture', displayName: 'Fixture', originalName: 'Fixture', franchise: 'Fixture', aliases: [],
  identityProse: 'An adult woman with black hair and blue eyes',
  identityTokens: ['1girl', 'solo', 'black_hair', 'blue_eyes', 'fox_tail'], exactTokens: [], exactPrefixes: [],
  recommendedEngine: 'anima', supportedEngines: ['anima', 'krea2'], adultEligibility: 'adult',
  outfits: [{ id: 'default', name: 'Default', tokens: ['school_uniform'], prose: 'a school uniform', default: true }],
}
const scene: RandomSceneContext = {
  prompt: 'indoors, classroom, night, running, school_uniform',
  prose: 'She is running in a classroom, wearing a school uniform.',
  tags: ['indoors', 'classroom', 'night', 'school_uniform'], action: 'running', time: 'night', lighting: null, shot: null,
}

describe('bounded scene-aware inspiration', () => {
  it('free mode supplies a setting, action and clothing without changing any identity dimension', () => {
    for (let seed = 0; seed < 40; seed++) {
      const [{ draw }] = randomCandidates({ tags, rich: true, allowClothing: true,
        identityExclude: new Set(character.identityTokens) }, seed, 1)
      expect(draw.manualTags.some(token => ['park', 'beach'].includes(token))).toBe(true)
      expect(draw.manualTags.some(token => ['standing', 'sitting'].includes(token))).toBe(true)
      expect(draw.variation.outfit.length).toBeGreaterThan(0)
      expect(draw.manualTags).not.toEqual(expect.arrayContaining(['white_hair']))
      expect(draw.manualTags.some(token => ['white_hair', 'purple_eyes', 'cat_ears', 'fox_tail', 'hair_bun'].includes(token))).toBe(false)
      const result = buildPopularPromptPlan({ character, outfit: character.outfits[0], blueprint: null,
        engine: 'anima', manual: draw.manualTags, outfitOverride: draw.variation.outfit })!
      expect(result.prompt).toContain('black hair')
      expect(result.prompt).not.toContain('white hair')
      expect(result.prompt).toContain('fox tail')
    }
  })

  it('selected night classroom keeps place and running while replacing independent wardrobe text', () => {
    for (let seed = 0; seed < 30; seed++) {
      const [{ draw }] = randomCandidates({ tags, scene, rich: true, allowClothing: true,
        officialOutfits: { jacket: ['jacket'] } }, seed, 1)
      expect(draw.manualTags.some(token => ['beach', 'park', 'sitting', 'standing', 'sunbeam'].includes(token))).toBe(false)
      expect(draw.variation.prompt).toContain('classroom')
      expect(draw.variation.prompt).toContain('running')
      expect(draw.variation.prompt).toContain('night')
      if (draw.variation.outfit.length) {
        expect(draw.variation.prompt).not.toContain('school_uniform')
        expect(draw.variation.tags).not.toContain('school_uniform')
        expect(draw.variation.prose).toContain('She is running in a classroom')
      }
      expect(['golden', 'window', 'overcast']).not.toContain(draw.lighting)
    }
  })

  it('structured scenes without authored action can vary posture, and recipes detach source context', () => {
    const structured = { ...scene, prompt: 'indoors, classroom, night', prose: '', action: '' }
    const [{ draw, recipe }] = randomCandidates({ tags, scene: structured, rich: true }, 42, 1)
    expect(draw.manualTags.some(token => ['standing', 'sitting'].includes(token))).toBe(true)
    structured.prompt = 'beach'
    expect(recipe.config.scene?.prompt).toBe('indoors, classroom, night')
  })

  it('retains intertwined or unknown prose and reports preserved dimensions', () => {
    const bound = { ...scene, prompt: 'coat, train_interior', prose: 'She is wearing a coat near the train doors.' }
    expect(canVarySceneOutfit(bound)).toBe(false)
    const [{ draw }] = randomCandidates({ tags, scene: bound, rich: true, allowClothing: true }, 1, 1)
    expect(draw.variation.outfit).toEqual([])
    expect(draw.variation.prose).toBe(bound.prose)
    expect(draw.kept).toContain('服装')
  })

  it('keeps action-like camera tags and updates only known framing/light phrases on later edits', () => {
    const authored = { ...scene, prompt: 'classroom, looking_back', prose: 'An extreme close-up in moonlight, before looking back toward the viewer.' }
    const overlay = sceneVariationOverlay(authored, [], tags, 'wide', 'lantern')
    expect(overlay.prompt).toContain('looking_back')
    expect(renderRandomVariationProse(overlay.prose, 'wide', 'lantern')).toBe('An wide shot in warm lighting, before looking back toward the viewer.')
    const changed = renderRandomVariationProse(overlay.prose, 'close', 'moon')
    expect(changed).toContain('close-up')
    expect(changed).not.toContain('wide shot')
    expect(changed).toContain('looking back toward the viewer')
    const lanternScene = 'She carries a paper lantern through the park in moonlight.'
    expect(renderRandomVariationProse(lanternScene, null, 'back')).toBe('She carries a paper lantern through the park in backlighting.')
    expect(hasVariableLight('She carries a paper lantern through the park.')).toBe(false)
    expect(renderRandomVariationProse('She reads in lantern light.', null, 'moon')).toBe('She reads in moonlight.')
  })
})
