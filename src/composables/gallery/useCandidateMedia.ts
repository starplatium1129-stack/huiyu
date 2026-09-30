import { reactive, ref } from 'vue'
import { artworkRepository } from '@/storage/artworkRepository'
import { safeImageUrl } from './galleryHelpers'
import type { ArtworkRecord } from '@/types/artwork'

/** At most two original reads and four owned URLs, including obsolete read generations. */
export function useCandidateMedia() {
  const urls = reactive<Record<string, string>>({}), loading = ref(false)
  const owned = new Set<string>()
  let request: AbortController | null = null, version = 0, active = 0, remaining = 0
  let queue: Array<{ item: ArtworkRecord; version: number; signal: AbortSignal }> = []
  function cancel() { request?.abort(); request = null; version++; queue = []; loading.value = false }
  function release() {
    cancel()
    for (const url of owned) URL.revokeObjectURL(url)
    owned.clear()
    for (const id of Object.keys(urls)) delete urls[id]
  }
  function pump() {
    while (active < 2 && queue.length) {
      const job = queue.shift()!
      if (job.signal.aborted || job.version !== version) continue
      active++
      void (async () => {
        try {
          const blob = job.item.image_id ? await artworkRepository.getImage(job.item.image_id, job.signal) : null
          if (job.version !== version || job.signal.aborted) return
          if (blob) {
            const url = URL.createObjectURL(blob)
            owned.add(url); urls[String(job.item.id)] = url
          } else {
            const source = String(job.item.image_data || job.item.image_url || '')
            const fallback = /^(data:image\/|blob:)/.test(source) ? source : safeImageUrl(source)
            if (fallback) urls[String(job.item.id)] = fallback
          }
        } catch { /* Keep an individual unavailable-image placeholder. */ }
        finally {
          active--
          if (job.version === version && --remaining === 0) loading.value = false
          pump()
        }
      })()
    }
  }
  function load(items: readonly ArtworkRecord[]) {
    release()
    request = new AbortController()
    const signal = request.signal
    queue = items.slice(0, 4).map(item => ({ item, version, signal }))
    remaining = queue.length; loading.value = remaining > 0
    pump()
  }
  return { urls, loading, load, cancel, release }
}
