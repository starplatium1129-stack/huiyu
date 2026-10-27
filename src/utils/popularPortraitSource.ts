import onboarding from '../../data/popular-onboarding.json' with { type: 'json' }
import { characterArtEntry } from '../platform/characterArtState.ts'
import { shallowRef } from 'vue'

const onboardingCharacters = onboarding.characters as Array<{
  id: string
  portraitPending: boolean
  portraitPlaceholder?: boolean
}>
const pendingIds = new Set(onboardingCharacters.filter(c => c.portraitPending).map(c => c.id))
const placeholderIds = new Set(onboardingCharacters.filter(c => c.portraitPending && c.portraitPlaceholder).map(c => c.id))
const catalogPendingIds = shallowRef(new Set<string>())

export function markCatalogPendingPortrait(id: string): void {
  catalogPendingIds.value = new Set([...catalogPendingIds.value, id])
}

export function adoptCatalogPendingPortraits(profiles: unknown): void {
  const pending = new Set<string>()
  if (Array.isArray(profiles)) for (const profile of profiles) {
    if (!profile || typeof profile !== 'object') continue
    const row = profile as { id?: unknown; portrait?: { image?: unknown } }
    if (typeof row.id === 'string' && row.portrait?.image === '../assets/characters/portrait-pending.svg') pending.add(row.id)
  }
  catalogPendingIds.value = pending
}

function pendingPortraitSrc(id: string, full: boolean): string {
  if (!placeholderIds.has(id)) return '/assets/characters/portrait-pending.svg'
  return full
    ? `/assets/characters/popular-${encodeURIComponent(id)}.png?placeholder=1`
    : `/assets/characters/thumbs/popular-${encodeURIComponent(id)}.webp?placeholder=1`
}

export function isPopularPortraitPending(id: string): boolean {
  return (pendingIds.has(id) || catalogPendingIds.value.has(id)) && !characterArtEntry(id)
}

/** Registration is usable before artwork is produced; never invent a missing asset URL. */
export function popularPortraitSrc(id: string, version?: string | number): string {
  const override = characterArtEntry(id)
  if (override) return override.thumbnailUrl
  if (isPopularPortraitPending(id)) return pendingPortraitSrc(id, false)
  const suffix = version === undefined ? '' : `?v=${encodeURIComponent(String(version))}`
  return `/assets/characters/thumbs/popular-${encodeURIComponent(id)}.webp${suffix}`
}

export function popularPortraitFullSrc(id: string): string {
  return characterArtEntry(id)?.portraitUrl || (isPopularPortraitPending(id) ? pendingPortraitSrc(id, true) : `/assets/characters/popular-${encodeURIComponent(id)}.png`)
}
