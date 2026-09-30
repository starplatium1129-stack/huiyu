import { expect, it } from 'vitest'
import { indexArtworkSearch } from './artworkSearch'
import { buildArtworkSearchIndex, parseArtworkSearchIndex } from '@/application/artwork/searchIndex'

it('indexes the complete library without copying image data or formatting every date', () => {
  const records = Array.from({ length: 10000 }, (_, i) => ({ id: i + 1, timestamp: i + 1, title: i === 0 ? 'Oldest Sentinel' : 'neutral', image_data: 'not copied' }))
  const index = indexArtworkSearch(buildArtworkSearchIndex(records))
  expect(index).toHaveLength(10000)
  expect(index.at(-1)).toMatchObject({ id: '1', keywords: 'oldest sentinel' })
  expect(index.every(item => !('image_data' in item) && !('meta' in item))).toBe(true)
})
it('uses stable timestamp ordering, rejects bad ids, and refreshes edits', () => {
  const raw = [{ id: 'b', timestamp: 100, prompt: 'neutral' }, { id: 'a', timestamp: 100 }, { id: '' }, { id: NaN }, null]
  expect(indexArtworkSearch(buildArtworkSearchIndex(raw)).map(item => item.id)).toEqual(['b', 'a'])
  raw[0]!.prompt = 'changed'
  expect(indexArtworkSearch(buildArtworkSearchIndex(raw))[0].keywords).toContain('changed')
  expect(indexArtworkSearch(buildArtworkSearchIndex(raw.slice(1))).map(item => item.id)).toEqual(['a'])
  expect(buildArtworkSearchIndex(null)).toEqual([])
  expect(indexArtworkSearch([])).toEqual([])
  expect(() => parseArtworkSearchIndex([{ id: 'missing-text' }])).toThrow('索引无效')
  expect(() => parseArtworkSearchIndex([{ id: null, searchText: 'x' }])).toThrow('索引无效')
  const dates = indexArtworkSearch(buildArtworkSearchIndex([
    { id: 'legacy', timestamp: 'Fri, 01 Jan 2021 00:00:00 GMT' },
    { id: 'numeric', timestamp: 1609459200000 },
    { id: '12', timestamp: 'invalid' },
  ]))
  expect(dates.map(item => item.id)).toEqual(['legacy', 'numeric', '12'])
  expect(dates.map(item => item.timestamp)).toEqual([1609459200000, 1609459200000, 12])
})
