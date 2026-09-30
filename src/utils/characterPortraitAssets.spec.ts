import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { isPopularPortraitPending, popularPortraitSrc } from './popularPortraitSource'
import onboarding from '../../data/popular-onboarding.json'
const read = (path: string) => readFileSync(path)
const digest = (path: string) => createHash('sha256').update(read(path)).digest('hex')
const selected = JSON.parse(read('assets/characters/portrait-selections.json').toString()) as {
  entries: Record<string, { entryId?: string; sourceImage: string; rating: string; portraitSha256: string; thumbnailSha256?: string }>
}
const catalog = JSON.parse(read('data/popular-characters.json').toString()) as { characters: { id: string }[] }
const profiles = JSON.parse(read('data/characters.json').toString()) as { id: string; portrait?: { image: string } }[]

describe('character portrait identity', () => {
  it('does not reuse one portrait file for distinct character identities', () => {
    const seen = new Map<string, string>()
    for (const { id } of catalog.characters) {
      if (isPopularPortraitPending(id)) {
        const registration = onboarding.characters.find(character => character.id === id)
        if (registration && 'portraitPlaceholder' in registration && registration.portraitPlaceholder) {
          expect(popularPortraitSrc(id)).toBe(`/assets/characters/thumbs/popular-${id}.webp?placeholder=1`)
          expect(read(`assets/characters/popular-${id}.png`).length).toBeGreaterThan(0)
          expect(read(`assets/characters/thumbs/popular-${id}.webp`).length).toBeGreaterThan(0)
        } else {
          expect(popularPortraitSrc(id)).toBe('/assets/characters/portrait-pending.svg')
        }
        continue
      }
      const hash = digest('assets/characters/popular-' + id + '.png')
      expect(seen.get(hash), id + ' must not reuse another character portrait').toBeUndefined()
      seen.set(hash, id)
    }
  })
  it.each(Object.entries(selected.entries))('keeps the registered portrait and derived assets for %s', (id, source) => {
    if (source.entryId) expect(source.entryId.startsWith('pc_' + id + '_')).toBe(true)
    expect(source.sourceImage).toBeTruthy()
    expect(source.rating).toBe('All')
    const cloud = JSON.parse(read('assets/particles/p_' + id + '.json').toString())
    expect(cloud.sourceSha256).toBe(source.portraitSha256)
    expect(cloud.id).toBe(id)
    expect(cloud.grid.cells.length).toBe(cloud.grid.w * cloud.grid.h)
    expect(digest('assets/characters/popular-' + id + '.png')).toBe(source.portraitSha256)
    if (source.thumbnailSha256) {
      expect(digest('assets/characters/thumbs/popular-' + id + '.webp')).toBe(source.thumbnailSha256)
      expect(profiles.find(profile => profile.id === id)?.portrait?.image).toBe(
        `../assets/characters/popular-${id}.png?v=${source.portraitSha256.slice(0, 12)}`,
      )
    } else {
      expect(digest('assets/characters/thumbs/popular-' + id + '.webp')).not.toBe(digest('assets/characters/thumbs/popular-kasumigaoka_utaha.webp'))
    }
  })
})
