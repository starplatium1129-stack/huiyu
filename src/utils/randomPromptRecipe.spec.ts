import { expect, it } from 'vitest'
import { MAX_RANDOM_CANDIDATES, randomCandidates, replayRandomRecipe } from './randomPromptRecipe'

it('serialized seed and pool snapshot reproduce candidates after live catalog changes', () => {
  const options = { tags: [{ en: 'park', cat: 'Scene' }, { en: 'library', cat: 'Scene' }], identityExclude: new Set(['white_hair']), keepArtists: ['rella'] }
  const candidates = randomCandidates(options, 42, 3)
  options.tags.splice(0); options.identityExclude.add('park'); options.keepArtists.length = 0
  for (const candidate of candidates) expect(replayRandomRecipe(JSON.parse(JSON.stringify(candidate.recipe)))).toEqual(candidate.draw)
  expect(candidates.map(candidate => candidate.recipe.seed)).toEqual([42, 43, 44])
})
it('bounds expansion and rejects incompatible pool versions', () => {
  for (const count of [0, -1, Infinity, NaN, 1.5, MAX_RANDOM_CANDIDATES + 1]) expect(() => randomCandidates({ tags: [] }, 0, count)).toThrow()
  const [{ recipe }] = randomCandidates({ tags: [] }, 0, 1)
  expect(() => replayRandomRecipe({ ...recipe, poolVersion: 99 })).toThrow('不兼容')
})

it('replay rejects invalid seeds instead of silently coercing them to another recipe', () => {
  const [{ recipe }] = randomCandidates({ tags: [] }, 0, 1)
  for (const seed of [-1, 0x100000000, 1.5, NaN, Infinity, '42', null]) {
    expect(() => replayRandomRecipe({ ...recipe, seed } as typeof recipe)).toThrow('种子')
  }
})

it('candidate seeds wrap at the uint32 boundary and remain reproducible', () => {
  const candidates = randomCandidates({ tags: [] }, 0xffffffff, 3)
  expect(candidates.map(candidate => candidate.recipe.seed)).toEqual([0xffffffff, 0, 1])
  for (const candidate of candidates) expect(replayRandomRecipe(candidate.recipe)).toEqual(candidate.draw)
})
