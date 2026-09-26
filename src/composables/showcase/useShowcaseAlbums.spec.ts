import { describe, expect, it } from 'vitest'
import { ref } from 'vue'
import type { ShowcaseEntry } from '@/utils/showcaseManifest'
import { buildShowcaseAlbums, useShowcaseAlbums } from './useShowcaseAlbums'

function sample(id: string, overrides: Partial<ShowcaseEntry> = {}): ShowcaseEntry {
  return { id, title: id, char: 'nene', type: 'scene', rating: 'All', category: '日常', story: '', attempt: 1, ...overrides }
}

describe('showcase album navigation', () => {
  it('only counts entries actually loaded and omits empty albums', () => {
    const albums = buildShowcaseAlbums([sample('s1'), sample('s2'), sample('a1', { type: 'artist' })])
    expect(albums.map(({ type, count }) => ({ type, count }))).toEqual([{ type: 'scene', count: 2 }, { type: 'artist', count: 1 }])
    expect(buildShowcaseAlbums([])).toEqual([])
  })

  it('chooses only All covers, including when sensitive samples precede them', () => {
    const albums = buildShowcaseAlbums([sample('adult', { rating: 'R18' }), sample('teen', { rating: 'R15' }), sample('safe')])
    expect(albums[0].count).toBe(3)
    expect(albums[0].cover?.id).toBe('safe')
  })

  it('keeps an album navigable with a placeholder when no safe cover exists', () => {
    const albums = buildShowcaseAlbums([sample('adult', { type: 'lora', rating: 'R18' }), sample('teen', { type: 'lora', rating: 'R15' })])
    expect(albums).toHaveLength(1)
    expect(albums[0]).toMatchObject({ type: 'lora', count: 2, cover: null })
  })

  it('updates covers and counts after a manifest refresh without mutating the entries', () => {
    const first = sample('old')
    const entries = ref([first])
    const albums = useShowcaseAlbums(entries)
    expect(albums.value[0].cover?.id).toBe('old')
    entries.value = [sample('new', { type: 'popular', char: 'character-id' })]
    expect(albums.value).toHaveLength(1)
    expect(albums.value[0]).toMatchObject({ type: 'popular', count: 1, cover: { id: 'new' } })
    expect(first).toEqual(sample('old'))
  })
})
