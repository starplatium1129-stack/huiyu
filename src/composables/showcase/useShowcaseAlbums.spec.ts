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
    expect(albums.filter(album => album.group === 'overview').map(({ type, count }) => ({ type, count }))).toEqual([{ type: 'scene', count: 2 }, { type: 'artist', count: 1 }])
    expect(albums.find(album => album.id === 'theme:日常')?.entryIds).toEqual(['s1', 's2'])
    expect(buildShowcaseAlbums([])).toEqual([])
  })

  it('chooses only All covers, including when sensitive samples precede them', () => {
    const albums = buildShowcaseAlbums([sample('adult', { rating: 'R18' }), sample('teen', { rating: 'R15' }), ...['safe', 'safe2', 'safe3', 'safe4'].map(id => sample(id))])
    expect(albums[0].count).toBe(6)
    expect(albums[0].covers.map(entry => entry.id)).toEqual(['safe', 'safe2', 'safe3'])
  })

  it('keeps an album navigable with a placeholder when no safe cover exists', () => {
    const albums = buildShowcaseAlbums([sample('adult', { type: 'lora', rating: 'R18' }), sample('teen', { type: 'lora', rating: 'R15' })])
    expect(albums).toHaveLength(1)
    expect(albums[0]).toMatchObject({ type: 'lora', count: 2, covers: [] })
  })

  it('updates covers and counts after a manifest refresh without mutating the entries', () => {
    const first = sample('old')
    const entries = ref([first])
    const albums = useShowcaseAlbums(entries)
    expect(albums.value[0].covers[0]?.id).toBe('old')
    entries.value = [sample('new', { type: 'popular', char: 'character-id' })]
    expect(albums.value).toHaveLength(1)
    expect(albums.value[0]).toMatchObject({ type: 'popular', count: 1, covers: [{ id: 'new' }] })
    expect(first).toEqual(sample('old'))
  })

  it('groups published samples by scene theme and known franchise with exact membership', () => {
    const entries = [sample('date', { category: '恋爱/After_Story' }), sample('home', { category: '日常生活' }),
      sample('raiden', { type: 'popular', char: 'raiden_shogun' }), sample('keqing', { type: 'popular', char: 'keqing', rating: 'R18' }),
      sample('unknown', { type: 'popular', char: 'unregistered' })]
    const albums = buildShowcaseAlbums(entries, [{ id: 'raiden_shogun', franchise: 'Genshin Impact' }, { id: 'keqing', franchise: 'Genshin Impact' }])
    expect(albums.find(album => album.id === 'theme:恋爱')?.entryIds).toEqual(['date'])
    expect(albums.find(album => album.id === 'theme:日常')?.entryIds).toEqual(['home'])
    expect(albums.filter(album => album.group === 'franchise')).toMatchObject([
      { id: 'franchise:Genshin Impact', title: '原神', count: 2, entryIds: ['raiden', 'keqing'], covers: [{ id: 'raiden' }] },
    ])
    expect(albums.find(album => album.id === 'popular')?.entryIds).toEqual(['raiden', 'keqing', 'unknown'])
  })
})
