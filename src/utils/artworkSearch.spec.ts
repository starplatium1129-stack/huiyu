import { expect, it } from 'vitest'
import { indexArtworkSearch } from './artworkSearch'

it('indexes the complete library without copying image data or formatting every date', () => {
  const records = Array.from({ length: 10000 }, (_, i) => ({ id: i + 1, timestamp: i + 1, title: i === 0 ? 'Oldest Sentinel' : 'neutral', image_data: 'not copied' }))
  const index = indexArtworkSearch(records)
  expect(index).toHaveLength(10000)
  expect(index.at(-1)).toMatchObject({ id: '1', keywords: 'oldest sentinel' })
  expect(index.every(item => !('image_data' in item) && !('meta' in item))).toBe(true)
})
it('uses stable timestamp ordering, rejects bad ids, and refreshes edits', () => {
  const raw = [{ id: 'b', timestamp: 100, prompt: 'neutral' }, { id: 'a', timestamp: 100 }, { id: '' }, { id: NaN }, null]
  expect(indexArtworkSearch(raw).map(item => item.id)).toEqual(['b', 'a'])
  raw[0]!.prompt = 'changed'
  expect(indexArtworkSearch(raw)[0].keywords).toContain('changed')
  expect(indexArtworkSearch(raw.slice(1)).map(item => item.id)).toEqual(['a'])
  expect(indexArtworkSearch(null)).toEqual([])
  expect(indexArtworkSearch([])).toEqual([])
})
