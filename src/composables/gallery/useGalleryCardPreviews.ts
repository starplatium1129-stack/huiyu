import { nextTick, type Ref } from 'vue'
import { artworkRepository } from '@/storage/artworkRepository'
import { imageMediaSession } from '@/platform/imageMediaSession'
import type { ArtworkRecord } from '@/types/artwork'
import { blobThumbDataUrl } from '@/utils/imageThumb'
import { safeImageUrl } from './galleryHelpers'
import { cardPreviewImage } from './cardPreviewImage'
import { sameArtworkMedia } from './artworkMediaIdentity'

interface CardPreviewOptions {
  shell: Ref<HTMLElement | null>
  items: () => ArtworkRecord[]
  active: () => boolean
  wallActive: () => boolean
  epoch: () => number
  signal: () => AbortSignal
  current: (item: ArtworkRecord) => boolean
  urls: Record<string, string>
  thumbnails: Record<string, string>
  rememberThumbnail: (id: string | number, url: string) => void
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
  const cards = new Map<Element, ArtworkRecord>()
  const widths = new Map<string | number, number>()
  const layoutWidths = new Map<Element, number>()
  const satisfied = new Map<string | number, number>()
  const cache = new Map<string | number, { bytes: number; pixels: number }>()
  const queue = new Map<string | number, PreviewRead>()
  const reads = new Map<string | number, { controller: AbortController; item: ArtworkRecord }>()
  let observer: IntersectionObserver | undefined, resize: ResizeObserver | undefined
  let workers = 0, scanPending = false
  let densityQuery: MediaQueryList | undefined
  const pixelWidth = (width: number) => Math.ceil(width * (window.devicePixelRatio || 1) * 1.06 / 560) * 560
  const wantedWidth = (id: string | number) => widths.get(id) || 560
  function releaseCardImage(id: string | number) {
    const url = options.urls[id]
    if (url?.startsWith('blob:')) URL.revokeObjectURL(url)
    delete options.urls[id]; cache.delete(id); satisfied.delete(id)
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
  async function dimensions(src: string, signal: AbortSignal) {
    signal.throwIfAborted()
    const image = new Image()
    const release = () => image.removeAttribute('src')
    signal.addEventListener('abort', release, { once: true })
    try {
      image.src = src
      await image.decode()
      signal.throwIfAborted()
      return { width: image.naturalWidth, height: image.naturalHeight }
    } finally {
      signal.removeEventListener('abort', release)
      release()
    }
  }
  async function hydrate({ item, repository, session }: PreviewRead, signal: AbortSignal) {
    const epoch = options.epoch(), width = wantedWidth(item.id)
    const current = () => !signal.aborted && options.active() && options.wallActive() && epoch === options.epoch() && options.current(item)
      && repository === artworkRepository && session === imageMediaSession()
    if (!current()) return
    let fallback = safeImageUrl(item.image_url) || (item.image_data?.startsWith('data:image/') ? item.image_data : '')
    let thumbnail = options.thumbnails[item.id]
    try {
      if (!item.image_id && !fallback && item._gallerySummary) {
        const complete = await repository.readArtwork(item.id, signal)
        if (!current()) return
        fallback = safeImageUrl(complete?.image_url) || (complete?.image_data?.startsWith('data:image/') ? complete.image_data : '')
      }
      if (!thumbnail && item.image_id) {
        try { thumbnail = await repository.getThumbnail(item.image_id) || '' }
        catch { /* A failed optional thumbnail must not prevent original recovery. */ }
      }
      if (!current()) return
      if (thumbnail?.startsWith('data:image/')) {
        try {
          const size = await dimensions(thumbnail, signal)
          if (!current()) return
          options.rememberThumbnail(item.id, thumbnail)
          if (size.width >= width) { satisfied.set(item.id, size.width); return }
        } catch {
          if (!current()) return
          thumbnail = ''; options.forgetThumbnail(item.id)
        }
      }
      if (item.image_id && repository.getPreview) {
        // Workspace derivatives survive the card's bounded memory cache. The
        // authority rounds up the requested size and never upscales originals.
        const preview = await repository.getPreview(item.image_id, width, signal).catch(() => null)
        if (!current()) return
        if (preview) {
          const size = await dimensions(preview, signal)
          if (!current()) return
          releaseCardImage(item.id)
          options.urls[item.id] = preview
          satisfied.set(item.id, size.width < width ? Infinity : size.width)
          cache.set(item.id, { bytes: preview.length * 2, pixels: size.width * size.height }); trim()
          return
        }
      }
      const blob = item.image_id ? await repository.getImage(item.image_id, signal) : null
      if (!current()) return
      let url = fallback, bytes = fallback.length * 2, pixels = 0, resolvedWidth = Infinity
      if (blob) {
        // Persist only the standard small thumbnail; larger previews stay local.
        if (!thumbnail && item.image_id) {
          thumbnail = await blobThumbDataUrl(blob)
          if (!current()) return
          if (thumbnail) {
            options.rememberThumbnail(item.id, thumbnail)
            void repository.setThumbnail(item.image_id, thumbnail).catch(() => {})
            const size = await dimensions(thumbnail, signal)
            if (!current()) return
            if (size.width >= width) { satisfied.set(item.id, size.width); return }
          }
        }
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
      }
      if (!url) { if (!thumbnail) options.markMissing(item.id); return }
      releaseCardImage(item.id)
      options.urls[item.id] = url; satisfied.set(item.id, resolvedWidth)
      cache.set(item.id, { bytes, pixels }); trim()
    } catch {
      if (!current()) return
      if (fallback) {
        releaseCardImage(item.id); options.urls[item.id] = fallback; satisfied.set(item.id, Infinity)
        cache.set(item.id, { bytes: fallback.length * 2, pixels: 32 * 1024 * 1024 }); trim()
      } else if (!options.thumbnails[item.id]) options.markMissing(item.id)
    }
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
            && !options.urls[id] && !options.thumbnails[id] && !options.missing(id)) options.markMissing(id)
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
    if ((options.urls[item.id] || options.thumbnails[item.id]) && (satisfied.get(item.id) || 0) >= wantedWidth(item.id)) {
      const entry = cache.get(item.id)
      if (entry) { cache.delete(item.id); cache.set(item.id, entry) }
      return
    }
    queue.set(item.id, { item: { ...item }, repository: artworkRepository, session: imageMediaSession() }); pump()
  }
  function retryCardImage(item: ArtworkRecord) {
    if (!options.active() || !options.wallActive() || !options.current(item) || !options.missing(item.id)
      || options.urls[item.id] || options.thumbnails[item.id]) return
    // Only an explicit retry expires this failed read; scrolling never loops it.
    options.clearMissing(item.id)
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
    const byId = new Map(options.items().map(item => [String(item.id), item]))
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
  }
  function releaseCardImages(retain: ReadonlySet<string>) {
    for (const id of cache.keys()) if (!retain.has(String(id))) releaseCardImage(id)
    for (const id of satisfied.keys()) if (!retain.has(String(id))) satisfied.delete(id)
  }
  return { returnThumbIds, releaseCardImage, releaseCardImages, cancelCardHydration, retainCardReads, stopCardObservation, scheduleWallScan, retryCardImage }
}
