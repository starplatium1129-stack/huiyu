import { computed } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { adoptCharacterArtManifest, clearCharacterArtManifest, characterArtEntry, type CharacterArtManifest } from './characterArtState'
import { resolveRuntimeUrl, setRuntimeOrigin } from './runtimeUrl'
import { popularPortraitSrc, isPopularPortraitPending } from '../utils/popularPortraitSource'
vi.mock('../../data/popular-onboarding.json', () => ({ default: { characters: [{ id: 'pending_fixture', portraitPending: true }] } }))
const environment = vi.hoisted(() => ({ local: true }))
vi.mock('../utils/runtimeEnvironment.ts', () => ({ isLocalStudioHost: () => environment.local }))

function manifest(id: string, revision: string): CharacterArtManifest {
  const base = `/api/character-art/${id}/${revision}/`
  return { version: revision, entries: { [id]: { revision, portraitUrl: `${base}portrait.png`, thumbnailUrl: `${base}thumbnail.png`, particleUrl: `${base}particles.json`, width: 512, height: 768, hasTransparency: true } } }
}
afterEach(() => { environment.local = true; clearCharacterArtManifest(); setRuntimeOrigin(null) })
describe('character art resource revisions', () => {
  it('reactively remaps only known portrait assets and restores the builtin on reset', () => {
    const src = computed(() => resolveRuntimeUrl('../assets/characters/nene-official.webp?v=old'))
    expect(src.value).toContain('nene-official')
    adoptCharacterArtManifest(manifest('nene', 'first'))
    expect(src.value).toBe('/api/character-art/nene/first/portrait.png')
    adoptCharacterArtManifest(manifest('nene', 'second'))
    expect(src.value).toContain('/second/')
    expect(resolveRuntimeUrl('/assets/characters/nene-home-cg-1024.webp')).toContain('home-cg')
    expect(resolveRuntimeUrl('https://other.test/assets/characters/nene-official.webp')).toContain('other.test')
    clearCharacterArtManifest()
    expect(src.value).toContain('nene-official')
  })
  it('routes desktop media through runtime origin and bypasses pending only while custom art exists', () => {
    const id = 'pending_fixture'
    adoptCharacterArtManifest(manifest(id, 'first'))
    setRuntimeOrigin('http://127.0.0.1:8765', true, 'epoch')
    expect(isPopularPortraitPending(id)).toBe(false)
    expect(resolveRuntimeUrl(popularPortraitSrc(id))).toBe(`http://127.0.0.1:8765/api/character-art/${id}/first/thumbnail.png`)
    clearCharacterArtManifest()
    expect(isPopularPortraitPending(id)).toBe(true)
  })
  it('never exposes local overrides to a remote host', () => {
    adoptCharacterArtManifest(manifest('nene', 'first'))
    environment.local = false
    expect(characterArtEntry('nene')).toBeUndefined()
    expect(resolveRuntimeUrl('/assets/characters/nene-official.webp')).toContain('nene-official')
  })
})
