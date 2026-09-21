import { expect, it } from 'vitest'
import { indexArtworkSearch, matchesArtwork } from './artworkSearch'

it.each([0, 1, 300, 301, 1000, 10000])('indexes the complete valid library of %i lightweight records', count => {
  const records = Array.from({ length: count }, (_, i) => ({ id: i + 1, timestamp: i + 1, title: i === 0 ? 'Oldest Sentinel' : 'neutral', image_data: 'not copied' }))
  const start = performance.now()
  const index = indexArtworkSearch(records)
  const found = index.filter(item => matchesArtwork(item.keywords, ' sentinel  OLDEST ')).slice(0, 5)
  console.info(JSON.stringify({ count, elapsedMs: performance.now() - start }))
  expect(index).toHaveLength(count)
  expect(found.map(item => item.id)).toEqual(count ? ['1'] : [])
  expect(index.every(item => !('image_data' in item))).toBe(true)
})
it('uses stable timestamp ordering, rejects bad ids, and refreshes edits', () => {
  const raw = [{ id: 'b', timestamp: 100, prompt: 'neutral' }, { id: 'a', timestamp: 100 }, { id: '' }, { id: NaN }, null]
  expect(indexArtworkSearch(raw).map(item => item.id)).toEqual(['b', 'a'])
  raw[0]!.prompt = 'changed'
  expect(indexArtworkSearch(raw)[0].keywords).toContain('changed')
  expect(indexArtworkSearch(raw.slice(1)).map(item => item.id)).toEqual(['a'])
})
