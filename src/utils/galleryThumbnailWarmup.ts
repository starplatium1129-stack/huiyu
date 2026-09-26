import { blobThumbDataUrl, thumbKey } from './imageThumb'

export interface ThumbnailWarmupDependencies {
  list(): Promise<unknown>
  get(imageId: string): Promise<unknown>
  put(imageId: string, value: string): Promise<unknown>
  image(id: string): Promise<Blob | null>
  render(blob: Blob): Promise<string>
  lock(key: string, work: () => Promise<boolean>): Promise<boolean>
  visible(): boolean
  listen(listener: () => void): () => void
  schedule(work: () => void): number
  cancel(handle: number): void
}

/** Optional prewarming only; demand-driven image loading stays independent. */
export function createThumbnailWarmup(deps: ThumbnailWarmupDependencies): () => void {
  let stopped = false
  let running = false
  let scheduled: number | null = null
  let ids: string[] | null = null
  let index = 0
  const active = () => !stopped && deps.visible()
  function schedule() {
    if (!active() || running || scheduled !== null || (ids && index >= ids.length)) return
    scheduled = deps.schedule(() => { scheduled = null; void step() })
  }
  async function step() {
    if (!active()) return
    running = true
    try {
      if (ids === null) {
        const records = await deps.list()
        ids = [...new Set((Array.isArray(records) ? records : []).flatMap(record =>
          record && typeof record.image_id === 'string' && record.image_id ? [record.image_id as string] : []))]
      }
      if (!active() || index >= ids.length) return
      const id = ids[index]
      const key = thumbKey(id)
      // Recheck inside the same-origin lock: another window may have published
      // while this window was waiting for ownership of the thumbnail key.
      const complete = await deps.lock(key, async () => {
        if (!active()) return false
        try {
          const cached = await deps.get(id)
          if (typeof cached === 'string' && cached.startsWith('data:image/')) return true
          if (!active()) return false
          const blob = await deps.image(id)
          if (!active()) return false
          if (blob) {
            const data = await deps.render(blob)
            if (data && !stopped) await deps.put(id, data)
          }
          return true
        } catch { return true } // A failed optional thumbnail never blocks the next one.
      })
      if (complete) index++
    } catch { ids = [] }
    finally { running = false; schedule() }
  }
  const unlisten = deps.listen(() => {
    if (!active() && scheduled !== null) { deps.cancel(scheduled); scheduled = null }
    schedule()
  })
  schedule()
  return () => {
    stopped = true
    unlisten()
    if (scheduled !== null) deps.cancel(scheduled)
    scheduled = null
  }
}

export function startGalleryThumbnailWarmup(): () => void {
  const locks = globalThis.navigator?.locks
  if (!locks) return () => {} // Skip optional work if cross-window exclusion is unavailable.
  return createThumbnailWarmup({
    list: async () => (await import('@/storage/artworkRepository')).artworkRepository.readHistory(),
    get: async id => (await import('@/storage/artworkRepository')).artworkRepository.getThumbnail(id),
    put: async (id, dataUrl) => (await import('@/storage/artworkRepository')).artworkRepository.setThumbnail(id, dataUrl),
    image: async id => (await import('@/storage/artworkRepository')).artworkRepository.getImage(id), render: blobThumbDataUrl,
    lock: async (key, work) => await locks.request(`huiyu-thumbnail:${key}`, work),
    visible: () => document.visibilityState === 'visible',
    listen: listener => { document.addEventListener('visibilitychange', listener); return () => document.removeEventListener('visibilitychange', listener) },
    schedule: work => typeof window.requestIdleCallback === 'function'
      ? window.requestIdleCallback(work, { timeout: 4000 }) : window.setTimeout(work, 120),
    cancel: handle => typeof window.cancelIdleCallback === 'function' ? window.cancelIdleCallback(handle) : window.clearTimeout(handle),
  })
}
