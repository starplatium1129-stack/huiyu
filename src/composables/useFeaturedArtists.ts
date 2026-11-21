import { computed, shallowRef } from 'vue'
import { createSharedComposable, useEventListener } from '@vueuse/core'
import { ARTIST_STYLE_CANDIDATES } from '@/config/artistStyles'
import { profileLocalStorage, writeProfileLocal } from '@/platform/web/profileStorage'
import { FEATURED_ARTISTS_KEY } from '@/utils/storageKeys'

const artistIds = new Set(ARTIST_STYLE_CANDIDATES.map(artist => artist.id))
export function canFeatureArtist(id: string | undefined): id is string {
  return typeof id === 'string' && artistIds.has(id)
}

function readFeaturedArtists(): ReadonlySet<string> {
  try {
    const saved: unknown = JSON.parse(profileLocalStorage.getItem(FEATURED_ARTISTS_KEY) ?? '[]')
    return new Set(Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string' && !!id) : [])
  } catch {
    return new Set()
  }
}

export const useFeaturedArtists = createSharedComposable(() => {
  const ids = shallowRef(readFeaturedArtists())
  function reload() {
    const saved = readFeaturedArtists()
    if (saved.size !== ids.value.size || [...saved].some(id => !ids.value.has(id))) ids.value = saved
  }

  useEventListener('storage', event => {
    if (event.key === FEATURED_ARTISTS_KEY || event.key === null) reload()
  })
  if (typeof window !== 'undefined') useEventListener(window as EventTarget, 'huiyu:profile-sync-complete', reload)

  function toggleFeaturedArtist(id: string) {
    if (!canFeatureArtist(id)) return
    const next = new Set(readFeaturedArtists())
    if (!next.delete(id)) next.add(id)
    const receipt = writeProfileLocal(FEATURED_ARTISTS_KEY, JSON.stringify([...next].sort()))
    ids.value = next
    // A confirmed desktop write can include changes made by another window.
    void receipt.confirm().then(reload, reload)
  }

  return { featuredArtistIds: computed(() => ids.value), toggleFeaturedArtist }
})
