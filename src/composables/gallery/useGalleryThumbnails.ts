import { reactive } from 'vue'

const CACHE_LIMIT = 96
const CACHE_BYTES = 8 * 1024 * 1024

/** Derived DataURLs only. Originals and viewer URLs keep their existing owners. */
export function useGalleryThumbnails(protectedIds: () => ReadonlySet<string>) {
  const urls = reactive<Record<string, string>>({})
  const order = new Map<string, number>()
  let bytes = 0
  function forget(id: string | number) {
    const key = String(id)
    bytes -= order.get(key) ?? 0
    order.delete(key)
    delete urls[key]
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
  function remember(id: string | number, dataUrl: string) {
    const key = String(id), size = (key.length + dataUrl.length) * 2
    forget(key)
    if (size > CACHE_BYTES) return
    urls[key] = dataUrl; order.set(key, size); bytes += size
    trim()
  }
  function retain(ids: ReadonlySet<string>) {
    for (const key of order.keys()) if (!ids.has(key)) forget(key)
  }
  function clear() { retain(new Set()) }
  return { urls, remember, forget, trim, retain, clear }
}
