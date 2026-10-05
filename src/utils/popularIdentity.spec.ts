import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { PopularCharacter, PopularOutfit } from '../types/character'
import { parsePopularCharacters, defaultOutfit } from './popularContent'
import { buildPopularPromptPlan } from './popularPromptBuilder'
import { standaloneIdentityTokens, standaloneIdentityProse } from './popularIdentity'

// Use the committed catalog export, not the ignored browser aggregate. Only
// character/outfit records are needed for this full-catalog prompt regression.
const snapshotRoot = resolve('data/catalog')
const manifest = JSON.parse(readFileSync(resolve(snapshotRoot, 'manifest.json'), 'utf8')) as { files: string[] }
type Snapshot = {
  id: string; sortOrder: number
  data: { id: string; popular?: PopularCharacter; characterId?: string; outfit?: PopularOutfit }
}
const records = manifest.files.filter(file => /^(character|outfit)\//.test(file))
  .map(file => JSON.parse(readFileSync(resolve(snapshotRoot, file), 'utf8')) as Snapshot)
  .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
const catalog = records.filter(record => record.data.popular).map(record => ({
  ...record.data.popular,
  outfits: records.filter(outfit => outfit.data.characterId === record.data.id).map(outfit => outfit.data.outfit),
}))

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
