import { expect, it } from 'vitest'
import { compareRecipes, snapshotHistoricalRecipe } from './recipeComparison'

it('keeps missing generation facts unknown and snapshots only provenance fields', () => {
  const record = { id: 1, prompt: 'saved caption', seed: 0, cfg: '0', checkpoint: 'old-model', size: '832×1216', image_data: 'large image', tags: ['collection'] }
  const original = snapshotHistoricalRecipe(record)
  record.prompt = 'later edit'
  expect(original).toMatchObject({ prompt: 'saved caption', seed: 0, cfg: '0', model: 'old-model', size: '832x1216' })
  expect(original).not.toHaveProperty('image_data')
  const rows = compareRecipes(original, { prompt: 'new caption', seed: 0, cfg: 0, model: 'current-model', size: '832x1216', engine: 'sd' })
  expect(rows.find(row => row.key === 'seed')).toMatchObject({ before: '0', after: '0', status: 'same' })
  expect(rows.find(row => row.key === 'cfg')?.status).toBe('same')
  expect(rows.find(row => row.key === 'engine')).toMatchObject({ before: '未记录', status: 'missing' })
  expect(rows.find(row => row.key === 'model')?.status).toBe('changed')
  expect(rows.find(row => row.key === 'prompt')).toMatchObject({ before: 'saved caption', after: 'new caption' })
})
it('preserves empty negative and zero LoRA strength, and reports an unavailable current request', () => {
  const original = snapshotHistoricalRecipe({ id: 2, engine: 'krea2', negative: '', loraId: 'fixture', loraStrength: 0 })
  const same = compareRecipes(original, { engine: 'krea2', negative: '', lora: 'fixture:0' })
  expect(same.find(row => row.key === 'negative')).toMatchObject({ before: '空', after: '空', status: 'same' })
  expect(same.find(row => row.key === 'lora')?.status).toBe('same')
  expect(compareRecipes(original, null).find(row => row.key === 'negative')?.status).toBe('unavailable')
})
