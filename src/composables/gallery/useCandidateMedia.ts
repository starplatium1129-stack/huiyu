import { onScopeDispose, reactive, watch } from 'vue'
import { artworkRepository, type ArtworkRepository } from '@/storage/artworkRepository'
import { onDesktopRuntime } from '@/platform/desktop/runtime'
import { imageMediaSession } from '@/platform/imageMediaSession'
import { runtimeResourceIdentity } from '@/platform/runtimeUrl'
import { safeImageUrl } from './galleryHelpers'
import { sameArtworkMedia } from './artworkMediaIdentity'
import type { ArtworkRecord } from '@/types/artwork'

/** At most two original reads; only the four current candidates retain URLs. */
export function useCandidateMedia() {
  const urls = reactive(new Map<string, string>()), reading = reactive(new Map<string, boolean>())
  const errors = reactive(new Map<string, string>()), revisions = reactive(new Map<string, number>())
  const details = reactive(new Map<string, ArtworkRecord>())
  const owned = new Set<string>(), records = new Map<string, ArtworkRecord>()
  type Visit = { repository: ArtworkRepository; current: () => boolean }
  type Job = { item: ArtworkRecord; visit: Visit; version: number; controller: AbortController; retry: boolean }
  const requests = new Map<string, Job>()
  let visit: Visit | null = null, disposed = false
  let repository = artworkRepository, mediaSession = imageMediaSession()
  let version = 0, active = 0, enabled = false, queue: Job[] = []
  function cancel() {
    visit = null; enabled = false; version++
    for (const job of requests.values()) job.controller.abort()
    requests.clear(); queue = []
    for (const id of reading.keys()) reading.set(id, false)
  }
  function drop(id: string) {
    const url = urls.get(id)
    if (url && owned.delete(url)) URL.revokeObjectURL(url)
    urls.delete(id); reading.delete(id); errors.delete(id); revisions.delete(id); details.delete(id); records.delete(id)
  }
  function release() {
    cancel()
    for (const id of records.keys()) drop(id)
    owned.clear()
  }
  function refreshSession() {
    const next = imageMediaSession()
    if (next === mediaSession && repository === artworkRepository) return
    release(); mediaSession = next; repository = artworkRepository
  }
  // Admission precedes the dialog's nextTick. A reconnect cannot revive this
  // visit even when the final session fields match the original connection.
  function beginVisit() {
    refreshSession(); cancel()
    if (disposed) return null
    const source = artworkRepository, session = imageMediaSession()
    const owner: Visit = { repository: source, current: () => !disposed && visit === owner
      && source === artworkRepository && session === imageMediaSession() }
    visit = owner
    return owner
  }
  function admit() { return enabled && visit?.current() ? visit : null }
  const current = (job: Job) => enabled && job.visit.current() && job.version === version && !job.controller.signal.aborted
    && requests.get(String(job.item.id)) === job
  function pump() {
    while (active < 2 && queue.length) {
      const job = queue.shift()!, id = String(job.item.id)
      if (!current(job)) continue
      active++
      void (async () => {
        try {
          const item = job.item._gallerySummary ? await job.visit.repository.readArtwork(job.item.id, job.controller.signal) : job.item
          if (!current(job)) return
          if (!item) throw new Error('作品已不在作品册')
          details.set(id, item)
          // A saved remote/data source remains a valid fallback when the local read fails.
          const blob = item.image_id ? await job.visit.repository.getImage(item.image_id, job.controller.signal).catch(() => null) : null
          if (!current(job)) return
          const fallback = String(item.image_data || item.image_url || '')
          const source = blob ? URL.createObjectURL(blob) : /^(data:image\/|blob:)/.test(fallback) ? fallback : safeImageUrl(fallback)
          if (!source) throw new Error('原图暂时没有读出来，作品记录仍保留。')
          const previous = urls.get(id)
          if (previous && source !== previous && owned.delete(previous)) URL.revokeObjectURL(previous)
          if (blob) owned.add(source)
          urls.set(id, source)
          if (job.retry) revisions.set(id, Date.now())
        } catch {
          if (current(job)) errors.set(id, '原图读取失败，请重新读取；作品记录仍保留。')
        }
        finally {
          active--
          if (current(job)) { requests.delete(id); reading.set(id, false) }
          pump()
        }
      })()
    }
  }
  function enqueue(item: ArtworkRecord, retry: boolean) {
    const owner = admit()
    const id = String(item.id)
    if (!owner || reading.get(id)) return
    const job = { item: { ...item }, visit: owner, version, controller: new AbortController(), retry }
    errors.set(id, ''); reading.set(id, true); requests.set(id, job); queue.push(job)
  }
  function load(items: readonly ArtworkRecord[], owner: Visit) {
    if (!owner.current()) return
    const candidates = items.slice(0, 4).map(item => ({ ...item }))
    for (const [id, record] of records) {
      if (!candidates.some(item => sameArtworkMedia(record, item) && item._galleryRevision === record._galleryRevision)) drop(id)
    }
    enabled = true
    for (const item of candidates) {
      const id = String(item.id)
      records.set(id, item)
      if (!urls.get(id)) enqueue(item, false)
    }
    pump()
  }
  function retry(item: ArtworkRecord) {
    const record = records.get(String(item.id))
    if (!admit() || !sameArtworkMedia(record, item) || record?._galleryRevision !== item._galleryRevision) return
    enqueue(item, true); pump()
  }
  function detailFor(item: ArtworkRecord): ArtworkRecord {
    // Web rows already contain the current metadata. Desktop detail bodies do
    // not carry the summary revision and may add legacy image_data, so compare
    // the requested summary, not the hydrated body, with the latest prop.
    if (!item._gallerySummary) return item
    const id = String(item.id), source = records.get(id), detail = details.get(id)
    if (!detail || !sameArtworkMedia(source, item) || source?._galleryRevision !== item._galleryRevision) return item
    return { ...detail, ...item, favorite: item.favorite, reviewState: item.reviewState, _gallerySummary: false }
  }
  const stopRuntime = onDesktopRuntime(refreshSession)
  const stopResources = watch(runtimeResourceIdentity, refreshSession, { flush: 'sync' })
  onScopeDispose(() => { disposed = true; stopRuntime(); stopResources(); release() })
  return { urls, reading, errors, revisions, detailFor, beginVisit, admit, load, retry, cancel, release }
}
