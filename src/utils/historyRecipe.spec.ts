import { expect, it } from 'vitest'
import { parseArtworkRecords } from '@/types/artwork'
import { parseHistoryRecipe } from './historyRecipe'

it('keeps record identity, extensions, project and favorite without inventing a recipe', () => {
  const old = { id: '0012', favorite: true, project: 'p1', extension: { untouched: true } }
  const records = parseArtworkRecords([old, { id: 0 }, { id: NaN }, [], {}])
  expect(records).toEqual([old, { id: 0 }])
  expect(records[0]).toBe(old)
  const result = parseHistoryRecipe(old)
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.recipe).toMatchObject({ id: '0012', project: 'p1', engine: undefined, seed: undefined, model: undefined })
  expect(result.notes.join(' ')).toContain('未记录种子')
  expect(old).toEqual({ id: '0012', favorite: true, project: 'p1', extension: { untouched: true } })
})

it('projects only checked fields, including zeroes and numeric legacy values', () => {
  const result = parseHistoryRecipe({ id: 0, seed: '0', cfg: 0, steps: '20', emotion: {}, manual_tags: [1], hiresFix: 'false', loraStrength: 0 })
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.recipe).toMatchObject({ seed: 0, cfg: 0, steps: 20, loraStrength: 0, emotion: undefined, manual_tags: undefined, hiresFix: undefined })
  expect(result.notes.join(' ')).toContain('emotion 格式无效')
})

it.each([42, null, 'future'])('does not present invalid engine %s as a complete recipe', engine => {
  expect(parseHistoryRecipe({ id: 'old', engine } as never).ok).toBe(false)
})

