import onboarding from '../../data/popular-onboarding.json' with { type: 'json' }
import { characterArtEntry } from '../platform/characterArtState.ts'

const pendingIds = new Set(onboarding.characters.filter(c => c.portraitPending).map(c => c.id))
const themeIds = new Set(onboarding.characters.map(c => c.id))

export function hasOnboardingTheme(id = ''): boolean { return themeIds.has(id) }

export function isPopularPortraitPending(id: string): boolean {
  return pendingIds.has(id) && !characterArtEntry(id)
}

/** Registration is usable before artwork is produced; never invent a missing asset URL. */
export function popularPortraitSrc(id: string, version?: string | number): string {
  const override = characterArtEntry(id)
  if (override) return override.thumbnailUrl
  if (isPopularPortraitPending(id)) return '/assets/characters/portrait-pending.svg'
  const suffix = version === undefined ? '' : `?v=${encodeURIComponent(String(version))}`
  return `/assets/characters/thumbs/popular-${encodeURIComponent(id)}.webp${suffix}`
}

export function popularPortraitFullSrc(id: string): string {
  return characterArtEntry(id)?.portraitUrl || (isPopularPortraitPending(id) ? '/assets/characters/portrait-pending.svg' : `/assets/characters/popular-${encodeURIComponent(id)}.png`)
}
