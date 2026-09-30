import { afterEach, describe, expect, it, vi } from 'vitest'
import { isPopularPortraitPending, popularPortraitSrc, popularPortraitFullSrc } from './popularPortraitSource'
import { loadPortraitCloud } from './particlePortrait'

afterEach(() => vi.unstubAllGlobals())

vi.mock('../../data/popular-onboarding.json', () => ({
  default: { characters: [
    { id: 'pending_test', portraitPending: true },
    { id: 'placeholder_test', portraitPending: true, portraitPlaceholder: true },
    { id: 'published_test', portraitPending: false },
  ] },
}))

describe('registered characters without generated portraits', () => {
  it('shows registered placeholder artwork without treating it as delivered', async () => {
    expect(isPopularPortraitPending('placeholder_test')).toBe(true)
    expect(popularPortraitSrc('placeholder_test')).toBe('/assets/characters/thumbs/popular-placeholder_test.webp?placeholder=1')
    expect(popularPortraitFullSrc('placeholder_test')).toBe('/assets/characters/popular-placeholder_test.png?placeholder=1')
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    expect(await loadPortraitCloud('placeholder_test')).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
  it('preserves existing portrait paths and versioned caching', () => {
    expect(isPopularPortraitPending('published_test')).toBe(false)
    expect(popularPortraitSrc('published_test', 42)).toBe('/assets/characters/thumbs/popular-published_test.webp?v=42')
  })
  it('shows an explicit pending placeholder without requesting a nonexistent particle asset', async () => {
    expect(isPopularPortraitPending('pending_test')).toBe(true)
    expect(popularPortraitSrc('pending_test', 42)).toBe('/assets/characters/portrait-pending.svg')
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    expect(await loadPortraitCloud('pending_test')).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
