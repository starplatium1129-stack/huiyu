import { afterEach, expect, it } from 'vitest'
import { profileLocalStorage } from '@/platform/web/profileStorage'
import { ARTIST_STYLE_OPTIONS } from '@/config/artistStyleCatalog'
import { useArtistStyleFunnel } from './useArtistStyleFunnel'

afterEach(() => {
  profileLocalStorage.removeItem('aics-artist-usage')
  profileLocalStorage.removeItem('aics-artist-recent')
})

it('keeps a bounded recent list, promotes reused styles and restores valid preferences', () => {
  const ids = ARTIST_STYLE_OPTIONS.slice(0, 14).map(option => option.id)
  profileLocalStorage.setItem('aics-artist-recent', JSON.stringify([ids[0], 'unknown-style', ids[0]]))
  const funnel = useArtistStyleFunnel(ARTIST_STYLE_OPTIONS)
  expect(funnel.recentIds.value).toEqual([ids[0]])
  funnel.recordUsage(ids)
  expect(funnel.recentIds.value).toEqual(ids.slice(0, 12))
  funnel.recordUsage([ids[4]!, ids[4]!, 'unknown-style'])
  expect(funnel.recentIds.value[0]).toBe(ids[4])
  expect(new Set(funnel.recentIds.value).size).toBe(12)
  expect(useArtistStyleFunnel(ARTIST_STYLE_OPTIONS).recentIds.value).toEqual(funnel.recentIds.value)
})

it('ignores malformed stored recent preferences', () => {
  profileLocalStorage.setItem('aics-artist-recent', '{')
  expect(useArtistStyleFunnel(ARTIST_STYLE_OPTIONS).recentIds.value).toEqual([])
})
