import { expect, it } from 'vitest'
import { indexArtworkSearch } from './artworkSearch'
import { searchArtworkRecords, parseArtworkSearchSummaries } from '@/application/artwork/searchIndex'

it('searches the complete library but retains only five detached summaries without image or prompt text', () => {
  const records = Array.from({ length: 10000 }, (_, i) => ({ id: i + 1, timestamp: i + 1, title: i === 0 ? 'Oldest Sentinel' : 'neutral', prompt: 'BLUE flower', image_data: 'not copied' }))
  expect(searchArtworkRecords(records, '  OLDEST sentinel ')).toMatchObject([{ id: 1 }])
  const result = searchArtworkRecords(records, 'flower blue')
  expect(result.map(row => row.id)).toEqual([10000, 9999, 9998, 9997, 9996])
  expect(result.every(item => !('image_data' in item) && !('prompt' in item) && !('searchText' in item))).toBe(true)
  result[0].title = 'changed by consumer'
  expect(records[9999].title).toBe('neutral')
})
it('uses stable timestamp ordering, rejects bad ids, and refreshes edits', () => {
  const raw = [{ id: 'b', timestamp: 100, prompt: 'neutral' }, { id: 'a', timestamp: 100, prompt: 'neutral' }, { id: '' }, { id: NaN }, null]
  expect(indexArtworkSearch(searchArtworkRecords(raw, 'neutral')).map(item => item.id)).toEqual(['b', 'a'])
  raw[0]!.prompt = 'changed'
  expect(searchArtworkRecords(raw, 'changed').map(item => item.id)).toEqual(['b'])
  expect(searchArtworkRecords(raw.slice(1), 'neutral').map(item => item.id)).toEqual(['a'])
  expect(searchArtworkRecords(null, 'neutral')).toEqual([])
  expect(searchArtworkRecords(raw, ' ')).toEqual([])
  expect(indexArtworkSearch([])).toEqual([])
  expect(() => parseArtworkSearchSummaries([{ id: null }])).toThrow('响应无效')
  const dates = indexArtworkSearch([
    { id: 'legacy', timestamp: 'Fri, 01 Jan 2021 00:00:00 GMT' },
    { id: 'numeric', timestamp: 1609459200000 },
    { id: '12', timestamp: 'invalid' },
  ])
  expect(dates.map(item => item.id)).toEqual(['legacy', 'numeric', '12'])
  expect(dates.map(item => item.timestamp)).toEqual([1609459200000, 1609459200000, 12])
})
