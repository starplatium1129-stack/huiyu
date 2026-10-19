import { reactive } from 'vue'
import { artworkRepository } from '@/storage/artworkRepository'
import { safeImageUrl } from './galleryHelpers'
import { sameArtworkMedia } from './artworkMediaIdentity'
import type { ArtworkRecord } from '@/types/artwork'

/** At most two original reads; only the four current candidates retain URLs. */
export function useCandidateMedia() {
  const urls = reactive<Record<string, string>>({}), reading = reactive<Record<string, boolean>>({})
  const errors = reactive<Record<string, string>>({}), revisions = reactive<Record<string, number>>({})
  const details = reactive<Record<string, ArtworkRecord>>({})
  const owned = new Set<string>(), records = new Map<string, ArtworkRecord>()
  type Job = { item: ArtworkRecord; version: number; controller: AbortController; retry: boolean }
  const requests = new Map<string, Job>()
  let version = 0, active = 0, enabled = false, queue: Job[] = []
  function cancel() {
    enabled = false; version++
    for (const job of requests.values()) job.controller.abort()
    requests.clear(); queue = []
    for (const id of Object.keys(reading)) reading[id] = false
  }
  function drop(id: string) {
    if (owned.delete(urls[id])) URL.revokeObjectURL(urls[id])
    delete urls[id]; delete reading[id]; delete errors[id]; delete revisions[id]; delete details[id]; records.delete(id)
  }
  function release() {
    cancel()
    for (const id of records.keys()) drop(id)
    owned.clear()
  }
  const current = (job: Job) => enabled && job.version === version && !job.controller.signal.aborted
    && requests.get(String(job.item.id)) === job
  function pump() {
    while (active < 2 && queue.length) {
      const job = queue.shift()!, id = String(job.item.id)
      if (!current(job)) continue
      active++
      void (async () => {
        try {
          const item = job.item._gallerySummary ? await artworkRepository.readArtwork(job.item.id, job.controller.signal) : job.item
          if (!current(job)) return
          if (!item) throw new Error('作品已不在作品册')
          details[id] = item
          // A saved remote/data source remains a valid fallback when the local read fails.
          const blob = item.image_id ? await artworkRepository.getImage(item.image_id, job.controller.signal).catch(() => null) : null
          if (!current(job)) return
          const fallback = String(item.image_data || item.image_url || '')
          const source = blob ? URL.createObjectURL(blob) : /^(data:image\/|blob:)/.test(fallback) ? fallback : safeImageUrl(fallback)
          if (!source) throw new Error('原图暂时没有读出来，作品记录仍保留。')
          const previous = urls[id]
          if (source !== previous && owned.delete(previous)) URL.revokeObjectURL(previous)
          if (blob) owned.add(source)
          urls[id] = source
          if (job.retry) revisions[id] = Date.now()
        } catch {
          if (current(job)) errors[id] = '原图读取失败，请重新读取；作品记录仍保留。'
        }
        finally {
          active--
          if (current(job)) { requests.delete(id); reading[id] = false }
          pump()
        }
      })()
    }
  }
  function enqueue(item: ArtworkRecord, retry: boolean) {
    const id = String(item.id)
    if (reading[id]) return
    const job = { item: { ...item }, version, controller: new AbortController(), retry }
    errors[id] = ''; reading[id] = true; requests.set(id, job); queue.push(job)
  }
  function load(items: readonly ArtworkRecord[]) {
    cancel()
    const candidates = items.slice(0, 4).map(item => ({ ...item }))
    for (const [id, record] of records) {
      if (!candidates.some(item => sameArtworkMedia(record, item) && item._galleryRevision === record._galleryRevision)) drop(id)
    }
    enabled = true
    for (const item of candidates) {
      const id = String(item.id)
      records.set(id, item)
      if (!urls[id]) enqueue(item, false)
    }
    pump()
  }
  function retry(item: ArtworkRecord) {
    if (!enabled || !sameArtworkMedia(records.get(String(item.id)), item)) return
    enqueue(item, true); pump()
  }
  return { urls, reading, errors, revisions, details, load, retry, cancel, release }
}
