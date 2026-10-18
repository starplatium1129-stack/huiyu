import { computed, onActivated, onDeactivated, onUnmounted, reactive, ref, watch, type Ref } from 'vue'
import { artworkRepository, type ArtworkRepository } from '@/storage/artworkRepository'
import { runtimeResourceIdentity } from '@/platform/runtimeUrl'
import { blobThumbDataUrl } from '@/utils/imageThumb'
import { useGalleryThumbnails } from '../gallery/useGalleryThumbnails'
import { useOriginalImage } from '../useOriginalImage'
import type { BatchDrawJob } from './useBatchDraw'

export type BatchArtworkJob = Pick<BatchDrawJob, 'id' | 'requestKey' | 'historyId' | 'imageId' | 'pendingImage' | 'status' | 'sceneTitle' | 'subtitle' | 'variant' | 'seed' | 'snapshot'>
type PendingImage = (requestKey: string) => Blob | null
export const hasBatchArtwork = (job: BatchArtworkJob) => Boolean(job.imageId || job.historyId != null || job.pendingImage)
const mediaKey = (job: BatchArtworkJob) => JSON.stringify([job.requestKey, job.imageId, job.historyId, job.pendingImage])

async function imageId(job: BatchArtworkJob, repository: ArtworkRepository, signal: AbortSignal): Promise<string | null> {
  signal.throwIfAborted()
  if (job.imageId) return job.imageId
  if (job.historyId == null) return null
  // Older saved plans contain only the library identity. Read that record, never
  // the original task or the full history, to recover its media reference.
  const entry = await repository.readArtwork(job.historyId, signal)
  signal.throwIfAborted()
  return entry && String(entry.id).trim() === String(job.historyId).trim() ? entry.image_id || null : null
}

/** The batch owns bounded derived previews, not one original per completed job. */
export function useBatchArtworkThumbnails(options: {
  jobs: Ref<readonly BatchArtworkJob[]>
  active: Ref<boolean>
  selectedId: Ref<string>
  pendingImage: PendingImage
}) {
  const pageActive = ref(true), visible = reactive(new Set<string>())
  const active = computed(() => options.active.value && pageActive.value)
  const jobs = computed(() => new Map(options.jobs.value.map(job => [job.id, job])))
  const demanded = computed(() => {
    const ids = new Set(visible)
    const available = options.jobs.value.filter(hasBatchArtwork)
    const index = available.findIndex(job => job.id === options.selectedId.value)
    if (index >= 0) available.slice(Math.max(0, index - 2), index + 3).forEach(job => ids.add(job.id))
    return ids
  })
  const cache = useGalleryThumbnails(() => demanded.value)
  const cards = new Map<string, Element>(), identities = new Map<string, string>(), attempted = new Map<string, string>()
  const pending = new Map<string, { controller: AbortController; identity: string }>()
  let observer: IntersectionObserver | null = null, disposed = false, revision = 0

  function stop() {
    revision++
    observer?.disconnect(); observer = null; visible.clear()
    pending.forEach(read => read.controller.abort())
    attempted.clear(); identities.clear(); cache.clear()
  }
  function observeCards() {
    if (!active.value || disposed) return
    if (typeof IntersectionObserver === 'undefined') {
      // Keep the fallback finite even when the browser cannot report visibility.
      options.jobs.value.slice(0, 12).forEach(job => visible.add(job.id))
      return
    }
    if (observer) return
    observer ??= new IntersectionObserver(entries => {
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.previewId
        if (!id) continue
        if (entry.isIntersecting) visible.add(id)
        else visible.delete(id)
      }
      cache.trim(); pump()
    }, { rootMargin: '200px' })
    cards.forEach(element => observer!.observe(element))
  }
  function bindCard(id: string, element: Element | null) {
    const previous = cards.get(id)
    if (previous === element) return
    if (previous) observer?.unobserve(previous)
    if (!element) { cards.delete(id); visible.delete(id); cache.trim(); return }
    cards.set(id, element)
    if (active.value) {
      observeCards()
      observer?.observe(element)
    }
  }
  function pump() {
    if (!active.value || disposed) return
    const version = revision
    for (const id of demanded.value) {
      if (pending.size >= 2) break
      const source = jobs.value.get(id)
      if (!source || !hasBatchArtwork(source) || cache.urls[id] || pending.has(id)) continue
      const identity = mediaKey(source)
      if (attempted.get(id) === identity) continue
      const job = { ...source }, repository = artworkRepository, runtime = runtimeResourceIdentity()
      const read = { controller: new AbortController(), identity }
      pending.set(id, read); attempted.set(id, identity)
      void (async () => {
        try {
          const retained = job.pendingImage ? options.pendingImage(job.requestKey) : null
          const alias = retained ? null : await imageId(job, repository, read.controller.signal)
          const thumbnail = retained ? await blobThumbDataUrl(retained) : alias ? await repository.getThumbnail(alias) : null
          read.controller.signal.throwIfAborted()
          const current = jobs.value.get(id)
          if (active.value && !disposed && version === revision && runtime === runtimeResourceIdentity()
            && repository === artworkRepository && current && mediaKey(current) === identity && thumbnail?.startsWith('data:image/')) {
            if (demanded.value.has(id)) {
              cache.remember(id, thumbnail)
              if (cache.urls[id]) attempted.delete(id)
            } else attempted.delete(id)
          }
        } catch { /* Derived data may be absent; opening the item still reads its own original. */ }
        finally {
          if (pending.get(id) === read) pending.delete(id)
          pump()
        }
      })()
    }
  }
  watch(() => options.jobs.value.map(job => [job.id, mediaKey(job), job.status]), () => {
    for (const [id, previous] of identities) {
      const job = jobs.value.get(id)
      if (!job || mediaKey(job) !== previous) {
        cache.forget(id); attempted.delete(id); pending.get(id)?.controller.abort(); identities.delete(id)
      }
    }
    options.jobs.value.forEach(job => identities.set(job.id, mediaKey(job)))
    // A just-committed Web thumbnail may still be completing its best-effort
    // derivation. Later batch updates retry only missing demanded previews.
    for (const id of attempted.keys()) if (!cache.urls[id] && !pending.has(id)) attempted.delete(id)
    observeCards(); pump()
  }, { flush: 'post', immediate: true })
  watch([active, runtimeResourceIdentity], () => {
    stop()
    if (active.value) { observeCards(); pump() }
  }, { flush: 'post' })
  watch(demanded, () => { cache.trim(); pump() }, { flush: 'post' })
  onActivated(() => { pageActive.value = true })
  onDeactivated(() => { pageActive.value = false; stop() })
  onUnmounted(() => { disposed = true; stop(); cards.clear() })
  return { urls: cache.urls, bindCard }
}

/** One owned original. Switching cancels the old read before admitting the next. */
export function useBatchArtworkOriginal(options: {
  current: Ref<BatchArtworkJob | undefined>
  active: Ref<boolean>
  pendingImage: PendingImage
}) {
  const original = useOriginalImage()
  async function load(preserve = false) {
    if (!options.active.value) { original.stop(); return }
    const source = options.current.value
    if (!source) { original.release(); return }
    const job = { ...source }, identity = mediaKey(job)
    await original.load({
      preserve,
      current: () => options.active.value && !!options.current.value && mediaKey(options.current.value) === identity,
      async read(signal, repository) {
        const retained = job.pendingImage ? options.pendingImage(job.requestKey) : null
        const alias = retained ? null : await imageId(job, repository, signal)
        signal.throwIfAborted()
        return retained || (alias ? await repository.getImage(alias, signal) : null)
      },
    })
  }
  watch(() => [options.current.value && mediaKey(options.current.value), options.active.value, original.session.value], () => { void load() }, { immediate: true, flush: 'post' })
  // Closing stops pending work but keeps the painted image until its exit ends.
  return { url: original.url, error: original.error, retry: () => load(true) }
}
