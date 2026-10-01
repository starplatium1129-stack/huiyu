import { expect, it } from 'vitest'
import catalog from '../../data/popular-characters.json'
import { parsePopularCharacters, defaultOutfit } from './popularContent'
import { buildPopularPromptPlan } from './popularPromptBuilder'
import { standaloneIdentityTokens, standaloneIdentityProse } from './popularIdentity'

it('separates transient direction from stable appearance without changing exact character names', () => {
  const tokens = ['toki (blue archive)', '1girl', 'solo', 'blonde_hair', 'side_ponytail', 'blue_eyes', 'halo',
    'expressionless', 'peace_sign', 'standing', 'full_body', 'pink_background', 'moonlight', 'school_uniform']
  expect(standaloneIdentityTokens(tokens)).toEqual([
    'toki (blue archive)', '1girl', 'solo', 'blonde_hair', 'side_ponytail', 'blue_eyes', 'halo',
  ])
  expect(tokens).toHaveLength(14)
})

it('uses the English identity name when the original-name field is localized', () => {
  const character = parsePopularCharacters(catalog).find(character => character.id === 'reze_chainsaw')!
  const prose = standaloneIdentityProse(character)
  expect(prose).toContain('Reze (Bomb Devil) from Chainsaw Man')
  expect(prose).toContain('purple hair')
  expect(prose).toContain('short hair')
  expect(prose).toContain('green eyes')
  expect(prose).not.toMatch(/smile|blush|蕾塞/)
})

it.each(['anima', 'krea2'] as const)('preserves a blue reference background for the full character catalog in %s', engine => {
  const characters = parsePopularCharacters(catalog)
  expect(characters.length).toBeGreaterThan(100)
  for (const character of characters) {
    const result = buildPopularPromptPlan({ character, outfit: defaultOutfit(character)!, blueprint: null, engine,
      outfitOverride: ['white_coat'], manual: ['blue_background', 'simple_background', 'sitting'],
    })!
    expect(result.prompt, character.id).toMatch(/blue[_ ]background/)
    expect(result.prompt, character.id).toContain('sitting')
    expect(result.prompt, character.id).toMatch(/white[_ ]coat/)
    expect(result.prompt, character.id).not.toMatch(/saturated colors|layered background depth|cinematic atmosphere|peace-sign pose/)
    expect(result.plan.outfitProse, character.id).toBe('white coat')
    if (engine === 'anima') {
      expect(result.plan.preserveTokens, character.id).toEqual(character.exactTokens)
    }
  }
})
