import { computed, nextTick, type Ref } from 'vue'
import { artworkRepository } from '@/storage/artworkRepository'
import { imageMediaSession } from '@/platform/imageMediaSession'
import type { ArtworkRecord } from '@/types/artwork'
import { blobThumbDataUrl } from '@/utils/imageThumb'
import { safeImageUrl } from './galleryHelpers'
import { cardPreviewImage } from '@/utils/cardPreviewImage'
import { sameArtworkMedia } from './artworkMediaIdentity'
import type { ArtworkDerivativeLease } from '@/application/artwork/artworkRepository'
import { readGalleryDerivative } from './readGalleryDerivative'

interface CardPreviewOptions {
  shell: Ref<HTMLElement | null>
  items: () => ArtworkRecord[]
  active: () => boolean
  wallActive: () => boolean
  epoch: () => number
  signal: () => AbortSignal
  current: (item: ArtworkRecord) => boolean
  urls: Map<string, string>
  thumbnails: ReadonlyMap<string, string>
  rememberThumbnail: (id: string | number, source: string | ArtworkDerivativeLease) => void
  forgetThumbnail: (id: string | number) => void
  markMissing: (id: string | number) => void
  clearMissing: (id: string | number) => void
  missing: (id: string | number) => boolean
  hydrateThumbnails: () => Promise<void>
  trimThumbnails: () => void
}
interface PreviewRead { item: ArtworkRecord; repository: typeof artworkRepository; session: string }

/** Wall previews own bounded display-sized images; the viewer owns originals. */
export function useGalleryCardPreviews(options: CardPreviewOptions) {
  const returnThumbIds = new Set<string>()
  const itemsById = computed(() => new Map(options.items().map(item => [String(item.id), item])))
  function viewportItems() {
    const items: ArtworkRecord[] = []
    for (const id of returnThumbIds) {
      const item = itemsById.value.get(id)
      if (item) items.push(item)
    }
    return items
  }
  const cards = new Map<Element, ArtworkRecord>()
  const widths = new Map<string | number, number>()
  const layoutWidths = new Map<Element, number>()
  const satisfied = new Map<string | number, number>()
  const cache = new Map<string | number, { bytes: number; pixels: number; lease?: ArtworkDerivativeLease }>()
  const brokenThumbnails = new Set<string | number>()
  const brokenDerivatives = new Set<string | number>()
  const queue = new Map<string | number, PreviewRead>()
  const reads = new Map<string | number, { controller: AbortController; item: ArtworkRecord }>()
  let observer: IntersectionObserver | undefined, resize: ResizeObserver | undefined
  let workers = 0, scanPending = false
  let densityQuery: MediaQueryList | undefined
  const pixelWidth = (width: number) => Math.ceil(width * (window.devicePixelRatio || 1) * 1.06 / 560) * 560
  const wantedWidth = (id: string | number) => widths.get(id) || 560
  const retired = new Map<string | number, { timer: number; dispose: () => void }>()
  function flushRetired(id?: string | number) {
    if (id !== undefined) {
      const entry = retired.get(id)
      if (!entry) return
      clearTimeout(entry.timer); retired.delete(id); entry.dispose()
      return
    }
    for (const [key, entry] of retired) { clearTimeout(entry.timer); retired.delete(key); entry.dispose() }
  }
  function releaseCardImage(id: string | number, deferRevoke = false) {
    const key = String(id)
    const url = options.urls.get(key)
    const lease = cache.get(id)?.lease
    const dispose = () => {
      if (lease) lease.release()
      else if (url?.startsWith('blob:')) URL.revokeObjectURL(url)
    }
    flushRetired(id)
    if (deferRevoke && (lease || url?.startsWith('blob:'))) {
      // Keep the replaced frame's blob URL alive briefly while GalleryArtworkCard decodes the upgrade.
      const timer = window.setTimeout(() => { retired.delete(id); dispose() }, 1500)
      retired.set(id, { timer, dispose })
    } else dispose()
    options.urls.delete(key)
    cache.delete(id); satisfied.delete(id)
  }
  function trim() {
    let bytes = 0, pixels = 0
    for (const entry of cache.values()) { bytes += entry.bytes; pixels += entry.pixels }
    for (const [id, entry] of cache) {
      if (cache.size <= 40 && bytes <= 16 * 1024 * 1024 && pixels <= 16 * 1024 * 1024) break
      // The active viewport owns its required resolution, including originals
      // whose codec cannot produce a preview. Budgets evict inactive images.
      if (returnThumbIds.has(String(id))) continue
      releaseCardImage(id); bytes -= entry.bytes; pixels -= entry.pixels
    }
  }
  function cancelCardHydration(id: string | number) {
    reads.get(id)?.controller.abort(); reads.delete(id); queue.delete(id)
  }
  function retainCardReads(ids: ReadonlySet<string | number>) {
    for (const id of new Set([...queue.keys(), ...reads.keys()])) if (!ids.has(id)) cancelCardHydration(id)
  }
  async function hydrate({ item, repository, session }: PreviewRead, signal: AbortSignal) {
    const epoch = options.epoch(), width = wantedWidth(item.id), id = String(item.id)
    const current = () => !signal.aborted && options.active() && options.wallActive() && epoch === options.epoch() && options.current(item)
      && repository === artworkRepository && session === imageMediaSession()
    if (!current()) return
    let fallback = safeImageUrl(item.image_url) || (item.image_data?.startsWith('data:image/') ? item.image_data : '')
    let thumbnail = options.thumbnails.get(id)
    let thumbnailLease: ArtworkDerivativeLease | null = null
    try {
      if (!item.image_id && !fallback && item._gallerySummary) {
        const complete = await repository.readArtwork(item.id, signal)
        if (!current()) return
        fallback = safeImageUrl(complete?.image_url) || (complete?.image_data?.startsWith('data:image/') ? complete.image_data : '')
      }
      if (!thumbnail && item.image_id && !brokenThumbnails.has(item.id)) {
        try {
          thumbnailLease = await readGalleryDerivative(repository, item.image_id, undefined, signal)
          thumbnail = thumbnailLease?.url || ''
        }
        catch { /* A failed optional thumbnail must not prevent original recovery. */ }
      }
      if (!current()) return
      if (thumbnailLease) {
        options.rememberThumbnail(item.id, thumbnailLease)
        thumbnailLease = null
      }
      // The thumbnail contract is at most 560 px and never enlarges a small
      // original. The card reports decode errors from its own image element.
      if (thumbnail && width <= 560 && !brokenThumbnails.has(item.id)) { satisfied.set(item.id, 560); return }
      if (item.image_id && !brokenThumbnails.has(item.id) && !brokenDerivatives.has(item.id) && (repository.getImageDerivative || repository.getPreview)) {
        // Workspace derivatives survive the card's bounded memory cache. The
        // authority rounds up the requested size and never upscales originals.
        let preview = await readGalleryDerivative(repository, item.image_id, Math.min(width, 8192), signal).catch(() => null)
        try {
          if (!current()) return
          if (preview) {
            const maxWidth = Math.min(width, 8192)
            const sourceWidth = Math.max(1, Number(item.image_width || item.actual?.width || item.width) || maxWidth)
            const sourceHeight = Math.max(1, Number(item.image_height || item.actual?.height || item.height) || sourceWidth * 1.5)
            const scale = Math.min(1, maxWidth / sourceWidth)
            releaseCardImage(item.id, true)
            options.urls.set(id, preview.url)
            satisfied.set(item.id, width)
            cache.set(item.id, { bytes: preview.bytes, pixels: sourceWidth * sourceHeight * scale * scale, lease: preview })
            preview = null
            trim()
            return
          }
        } catch {
          if (!current()) return
        } finally {
          preview?.release()
        }
      }
      const blob = item.image_id ? await repository.getImage(item.image_id, signal) : null
      if (!current()) return
      let url = fallback, bytes = fallback.length * 2, pixels = 0, resolvedWidth = Infinity
      let thumbnailSource: Blob | undefined
      if (blob) {
        const preview = await cardPreviewImage(blob, width, signal)
        if (!current()) return
        if (preview) {
          // Only accepted previews get URLs; late/cancelled encodes own no URL.
          url = URL.createObjectURL(preview.blob); bytes = preview.blob.size; pixels = preview.width * preview.height
          resolvedWidth = preview.width < width ? Infinity : preview.width
        } else {
          // Unsupported originals retain their existing display fallback.
          url = URL.createObjectURL(blob); bytes = blob.size; pixels = 32 * 1024 * 1024
        }
        thumbnailSource = preview?.blob || blob
      }
      if (!url) { if (!thumbnail) options.markMissing(item.id); return }
      releaseCardImage(item.id, true)
      options.urls.set(id, url); satisfied.set(item.id, resolvedWidth)
      cache.set(item.id, { bytes, pixels }); trim()
      // Show the card first, then persist its small thumbnail from the reduced
      // preview. This avoids decoding the full original a second time.
      if (!thumbnail && item.image_id && thumbnailSource) {
        thumbnail = await blobThumbDataUrl(thumbnailSource)
        if (!current()) return
        if (thumbnail) {
          brokenThumbnails.delete(item.id)
          options.rememberThumbnail(item.id, thumbnail)
          void repository.setThumbnail(item.image_id, thumbnail).catch(() => {})
        }
      }
    } catch {
      if (!current()) return
      if (fallback) {
        releaseCardImage(item.id, true)
        options.urls.set(id, fallback); satisfied.set(item.id, Infinity)
        cache.set(item.id, { bytes: fallback.length * 2, pixels: 32 * 1024 * 1024 }); trim()
      } else if (!options.thumbnails.has(id)) options.markMissing(item.id)
    } finally { thumbnailLease?.release() }
  }
  function pump() {
    while (options.active() && workers < 2 && queue.size) {
      const [id, read] = queue.entries().next().value!, { item } = read
      queue.delete(id)
      const width = wantedWidth(id)
      const controller = new AbortController(); reads.set(id, { controller, item }); workers++
      void hydrate(read, AbortSignal.any([options.signal(), controller.signal])).finally(() => {
        if (reads.get(id)?.controller === controller) {
          reads.delete(id)
          // A source change retires pixels, but leaves an explicit retry rather
          // than an endless skeleton. Never overwrite a replacement read's state.
          if (!controller.signal.aborted && options.active() && options.wallActive() && options.current(item)
            && !options.urls.has(String(id)) && !options.thumbnails.has(String(id)) && !options.missing(id)) options.markMissing(id)
        }
        // Storage and native image work may outlive cancellation. Return this
        // worker only after their real promises settle; stale results stay hidden.
        workers--
        if (!controller.signal.aborted && wantedWidth(id) > width && returnThumbIds.has(String(id))) request(item)
        pump()
      })
    }
  }
  function request(item: ArtworkRecord) {
    if (!options.active() || !options.wallActive() || !options.current(item) || options.missing(item.id)) return
    const pending = reads.get(item.id)
    if (pending) {
      if (sameArtworkMedia(pending.item, item) && pending.item._galleryRevision === item._galleryRevision) return
      cancelCardHydration(item.id)
    }
    const queued = queue.get(item.id)
    if (queued && sameArtworkMedia(queued.item, item) && queued.item._galleryRevision === item._galleryRevision) return
    if ((options.urls.has(String(item.id)) || options.thumbnails.has(String(item.id))) && (satisfied.get(item.id) || 0) >= wantedWidth(item.id)) {
      const entry = cache.get(item.id)
      if (entry) { cache.delete(item.id); cache.set(item.id, entry) }
      return
    }
    queue.set(item.id, { item: { ...item }, repository: artworkRepository, session: imageMediaSession() }); pump()
  }
  function retryCardImage(item: ArtworkRecord) {
    if (!options.active() || !options.wallActive() || !options.current(item) || !options.missing(item.id)
      || options.urls.has(String(item.id)) || options.thumbnails.has(String(item.id))) return
    // Only an explicit retry expires this failed read; scrolling never loops it.
    options.clearMissing(item.id)
    request(item)
  }
  function discardBrokenThumbnail(item: ArtworkRecord) {
    if (!options.current(item)) return
    options.forgetThumbnail(item.id)
    if (!options.urls.has(String(item.id))) {
      if (brokenThumbnails.has(item.id)) return
      brokenThumbnails.add(item.id)
      satisfied.delete(item.id)
      cancelCardHydration(item.id)
      request(item)
    }
  }
  function discardBrokenDerivative(item: ArtworkRecord) {
    if (!options.current(item) || !cache.get(item.id)?.lease) return
    brokenDerivatives.add(item.id)
    releaseCardImage(item.id)
    cancelCardHydration(item.id)
    request(item)
  }
  function measure(element: Element, width: number) {
    const item = cards.get(element)
    if (!item || width <= 0) return
    layoutWidths.set(element, width)
    const previous = wantedWidth(item.id), next = pixelWidth(width)
    widths.set(item.id, next)
    if (next !== previous && returnThumbIds.has(String(item.id))) request(item)
  }
  function densityChanged() {
    for (const [element, width] of layoutWidths) if (returnThumbIds.has(String(cards.get(element)?.id))) measure(element, width)
    observeDensity()
  }
  function observeDensity() {
    densityQuery?.removeEventListener('change', densityChanged)
    densityQuery = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
    densityQuery.addEventListener('change', densityChanged)
  }
  function scanWallCards() {
    const elements = new Set(options.active() && options.wallActive() ? options.shell.value?.querySelectorAll<HTMLElement>('.artwork') : [])
    for (const [element, item] of cards) if (!elements.has(element as HTMLElement)) {
      observer?.unobserve(element); resize?.unobserve(element); cards.delete(element); layoutWidths.delete(element)
      returnThumbIds.delete(String(item.id)); widths.delete(item.id); cancelCardHydration(item.id)
    }
    trim()
    if (!elements.size) return
    if (!densityQuery) observeDensity()
    observer ??= new IntersectionObserver(entries => {
      for (const entry of entries) {
        const item = cards.get(entry.target)
        if (!item) continue
        if (entry.isIntersecting) {
          measure(entry.target, entry.boundingClientRect.width)
          returnThumbIds.add(String(item.id)); request(item)
        } else { returnThumbIds.delete(String(item.id)); cancelCardHydration(item.id) }
      }
      trim(); options.trimThumbnails(); void options.hydrateThumbnails()
    }, { rootMargin: '600px 0px' })
    resize ??= new ResizeObserver(entries => { for (const entry of entries) measure(entry.target, entry.contentRect.width) })
    const byId = itemsById.value
    for (const element of elements) {
      const item = byId.get(element.dataset.cardId || '')
      if (!item) continue
      const previous = cards.get(element)
      cards.set(element, item)
      if (!previous) { observer.observe(element); resize.observe(element) }
      else if (returnThumbIds.has(String(item.id))) request(item)
    }
  }
  function scheduleWallScan() {
    if (scanPending || !options.active()) return
    scanPending = true
    void nextTick(() => { scanPending = false; if (options.active()) scanWallCards() })
  }
  function stopCardObservation() {
    observer?.disconnect(); resize?.disconnect(); cards.clear(); returnThumbIds.clear(); widths.clear(); layoutWidths.clear()
    densityQuery?.removeEventListener('change', densityChanged); densityQuery = undefined
    retainCardReads(new Set())
    flushRetired()
  }
  function releaseCardImages(retain: ReadonlySet<string>) {
    for (const id of cache.keys()) if (!retain.has(String(id))) releaseCardImage(id)
    for (const id of retired.keys()) if (!retain.has(String(id))) flushRetired(id)
    for (const id of satisfied.keys()) if (!retain.has(String(id))) satisfied.delete(id)
  }
  return {
    returnThumbIds, viewportItems, releaseCardImage, releaseCardImages, cancelCardHydration,
    retainCardReads, stopCardObservation, scheduleWallScan, retryCardImage, discardBrokenThumbnail, discardBrokenDerivative,
    thumbnailBlocked: (id: string | number) => brokenThumbnails.has(id),
    resetPreviewFailures(id: string | number) { brokenThumbnails.delete(id); brokenDerivatives.delete(id) },
  }
}
