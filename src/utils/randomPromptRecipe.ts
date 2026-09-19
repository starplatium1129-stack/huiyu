import { randomPromptPlan, type RandomInspirationOptions } from './randomPromptAssembler'
import pools from '@/config/randomInspirationPools.json'

export const MAX_RANDOM_CANDIDATES = 8
export interface RandomRecipe {
  schemaVersion: 1
  poolVersion: number
  algorithm: 'huiyu-random-v1'
  seed: number
  config: Omit<RandomInspirationOptions, 'rng' | 'identityExclude'> & { identityExclude?: string[] }
}
export function seededRandom(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let x = Math.imul(state ^ (state >>> 15), 1 | state)
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x)
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
}
export function randomRecipe(options: RandomInspirationOptions, seed: number): RandomRecipe {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('种子须为 0–4294967295 的整数')
  const { rng: _rng, identityExclude, ...config } = options
  return {
    schemaVersion: 1, poolVersion: pools.version, algorithm: 'huiyu-random-v1', seed,
    config: JSON.parse(JSON.stringify({ ...config, ...(identityExclude ? { identityExclude: [...identityExclude] } : {}) })),
  }
}
export function replayRandomRecipe(recipe: RandomRecipe) {
  if (recipe.schemaVersion !== 1 || recipe.poolVersion !== pools.version || recipe.algorithm !== 'huiyu-random-v1') throw new Error('随机配方版本不兼容')
  return randomPromptPlan({ ...recipe.config, identityExclude: recipe.config.identityExclude ? new Set(recipe.config.identityExclude) : undefined, rng: seededRandom(recipe.seed) })
}
export function randomCandidates(options: RandomInspirationOptions, seed: number, count: number) {
  if (!Number.isInteger(count) || count < 1 || count > MAX_RANDOM_CANDIDATES) throw new Error(`候选数量须为 1–${MAX_RANDOM_CANDIDATES}`)
  randomRecipe(options, seed) // validate seed before bounded expansion
  return Array.from({ length: count }, (_, i) => {
    const recipe = randomRecipe(options, (seed + i) >>> 0)
    return { recipe, draw: replayRandomRecipe(recipe) }
  })
}
