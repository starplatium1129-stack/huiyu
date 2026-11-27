import { shallowReactive } from 'vue'
import type { ArtworkDerivativeLease } from '@/application/artwork/artworkRepository'

const CACHE_LIMIT = 96
const CACHE_BYTES = 8 * 1024 * 1024

/** The wall owns one lease per displayed thumbnail. */
export function useGalleryThumbnails(protectedIds: () => ReadonlySet<string>) {
  // A card subscribes to its own key, including legacy IDs matching Vue flags.
  const urls = shallowReactive(new Map<string, string>())
  const order = new Map<string, { bytes: number; lease?: ArtworkDerivativeLease }>()
  let bytes = 0
  function forget(id: string | number) {
    const key = String(id)
    const entry = order.get(key)
    bytes -= entry?.bytes ?? 0
    entry?.lease?.release()
    order.delete(key)
    urls.delete(key)
  }
  function trim() {
    const protectedKeys = protectedIds()
    for (const key of order.keys()) {
      if (order.size <= CACHE_LIMIT && bytes <= CACHE_BYTES) break
      // The current viewport is finite; keep its required previews even if it
      // exceeds the inactive cache budget, rather than blanking painted cards.
      if (!protectedKeys.has(key)) forget(key)
    }
  }
  function remember(id: string | number, source: string | ArtworkDerivativeLease) {
    const lease = typeof source === 'string' ? undefined : source
    const url = typeof source === 'string' ? source : source.url
    const key = String(id), size = key.length * 2 + (lease?.bytes ?? url.length * 2)
    forget(key)
    if (size > CACHE_BYTES) { lease?.release(); return }
    urls.set(key, url)
    order.set(key, { bytes: size, lease }); bytes += size
    trim()
  }
  function retain(ids: ReadonlySet<string>) {
    for (const key of order.keys()) if (!ids.has(key)) forget(key)
  }
  function clear() { retain(new Set()) }
  return { urls, remember, forget, trim, retain, clear }
}
