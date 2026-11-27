import { computed, onActivated, onDeactivated, onScopeDispose, ref, toValue, watch, type MaybeRefOrGetter } from 'vue'
import { resolveRuntimeUrl, runtimeFetch, runtimeResourceIdentity } from '@/platform/runtimeUrl'
import { cardPreviewImage } from '@/utils/cardPreviewImage'

interface ImageObserver {
  visible: (value: boolean) => void
  resize: (width: number, height: number) => void
  density: () => void
}

// A page can contain many cards, so share observers and the image-work budget.
const observed = new Map<Element, ImageObserver>()
const inViewport = new Set<Element>()
let intersection: IntersectionObserver | undefined, resize: ResizeObserver | undefined
let densityQuery: MediaQueryList | undefined, workers = 0
const waiting = new Set<() => void>()
interface CachedPreview { url: string; width: number; bytes: number; readers: number }
const previewCache = new Map<string, CachedPreview>()
let cacheBytes = 0
function evictPreview(key: string, entry: CachedPreview) {
  if (previewCache.get(key) !== entry) return
  previewCache.delete(key); cacheBytes -= entry.bytes
  if (!entry.readers) URL.revokeObjectURL(entry.url)
}
function trimPreviews() {
  for (const [key, entry] of previewCache) {
    if (previewCache.size <= 32 && cacheBytes <= 16 * 1024 * 1024) break
    if (!entry.readers) evictPreview(key, entry)
  }
}
async function leasePreview(source: string, width: number, signal: AbortSignal) {
  const key = JSON.stringify([runtimeResourceIdentity(), source, width])
  let entry = previewCache.get(key)
  if (!entry) {
    const result = await createPreview(source, width, signal)
    signal.throwIfAborted()
    if (!result) return
    entry = previewCache.get(key)
    if (!entry) {
      entry = { url: URL.createObjectURL(result.blob), width: result.width, bytes: result.blob.size, readers: 0 }
      cacheBytes += entry.bytes
    }
  }
  const current = entry
  previewCache.delete(key); previewCache.set(key, current)
  current.readers++
  trimPreviews()
  return {
    url: current.url, width: current.width,
    invalidate: () => evictPreview(key, current),
    release() {
      if (--current.readers === 0 && previewCache.get(key) !== current) URL.revokeObjectURL(current.url)
      trimPreviews()
    },
  }
}

function watchDensity() {
  densityQuery?.removeEventListener('change', densityChanged)
  densityQuery = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
  densityQuery.addEventListener('change', densityChanged)
}
function densityChanged() {
  watchDensity()
  for (const observer of observed.values()) observer.density()
}
function visibilityChanged() {
  for (const element of inViewport) observed.get(element)?.visible(!document.hidden)
}
function observeImage(element: HTMLImageElement, observer: ImageObserver) {
  if (!observed.size) document.addEventListener('visibilitychange', visibilityChanged)
  observed.set(element, observer)
  intersection ??= new IntersectionObserver(entries => {
    for (const entry of entries) {
      const owner = observed.get(entry.target)
      if (!owner) continue
      if (entry.isIntersecting) inViewport.add(entry.target)
      else inViewport.delete(entry.target)
      owner.visible(entry.isIntersecting && !document.hidden)
    }
  })
  resize ??= new ResizeObserver(entries => {
    for (const entry of entries) observed.get(entry.target)?.resize(entry.contentRect.width, entry.contentRect.height)
  })
  if (!densityQuery) watchDensity()
  intersection.observe(element); resize.observe(element)
}
function unobserveImage(element: HTMLImageElement) {
  observed.delete(element); inViewport.delete(element); intersection?.unobserve(element); resize?.unobserve(element)
  if (observed.size) return
  document.removeEventListener('visibilitychange', visibilityChanged)
  intersection?.disconnect(); resize?.disconnect(); intersection = undefined; resize = undefined
  densityQuery?.removeEventListener('change', densityChanged); densityQuery = undefined
}
async function acquire(signal: AbortSignal) {
  signal.throwIfAborted()
  if (workers < 2) { workers++; return }
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => { waiting.delete(ready); signal.removeEventListener('abort', abort) }
    const ready = () => { if (workers < 2) { cleanup(); workers++; resolve() } }
    const abort = () => { cleanup(); reject(signal.reason) }
    waiting.add(ready); signal.addEventListener('abort', abort, { once: true })
  })
}
async function createPreview(source: string, width: number, signal: AbortSignal) {
  await acquire(signal)
  try {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(30_000)])
    const url = new URL(source, window.location.href)
    url.searchParams.set('preview', String(Math.min(width, 3360)))
    const response = await runtimeFetch(url.href, { signal: bounded })
    if (!response.ok) throw new Error('样张预览暂不可用')
    const blob = await response.blob()
    bounded.throwIfAborted()
    const providedWidth = Number(response.headers.get('X-Huiyu-Preview-Width'))
    if (providedWidth > 0) return { blob, width: providedWidth }
    // Earlier gateways ignore the size query and return the original.
    return await cardPreviewImage(blob, width, bounded)
  } finally {
    workers--
    for (const ready of waiting) ready()
  }
}

/** Keep the thumbnail painted while a visible card gets display-sized pixels. */
export function useShowcaseCardPreview(thumbnail: MaybeRefOrGetter<string>, original: MaybeRefOrGetter<string>, fit: () => 'contain' | 'cover') {
  const previewSrc = ref(''), previewReady = ref(false)
  const source = computed(() => resolveRuntimeUrl(toValue(original)))
  let image: HTMLImageElement | undefined, active = true, visible = false, watching = false
  let boxWidth = 0, boxHeight = 0, satisfied = 0, failed = 0
  let request: AbortController | undefined
  let lease: Awaited<ReturnType<typeof leasePreview>>
  const retired = new Set<NonNullable<typeof lease>>()
  function releaseRetired() {
    for (const entry of retired) entry.release()
    retired.clear()
  }

  function clearPreview() {
    request?.abort(); request = undefined; satisfied = 0
    lease?.release(); lease = undefined
    releaseRetired(); previewSrc.value = ''; previewReady.value = false
  }
  function stopWatching() {
    if (image && watching) unobserveImage(image)
    watching = false; visible = false; boxWidth = boxHeight = 0
    clearPreview()
  }
  function requiredWidth() {
    if (!image || !boxWidth || !boxHeight || !image.naturalHeight) return 0
    const ratio = image.naturalWidth / image.naturalHeight
    const width = fit() === 'cover' ? Math.max(boxWidth, boxHeight * ratio) : Math.min(boxWidth, boxHeight * ratio)
    return width * (window.devicePixelRatio || 1) * 1.06
  }
  function requestPreview() {
    if (!active || !visible || request || !image || !source.value) return
    const required = requiredWidth(), currentImage = image, currentSource = source.value
    if (!required || required <= currentImage.naturalWidth || required <= satisfied) return
    const width = Math.min(3360, Math.ceil(required / 560) * 560)
    if (failed >= width) return
    const controller = new AbortController()
    request = controller
    void leasePreview(currentSource, width, controller.signal).then(result => {
      if (!result) { if (!controller.signal.aborted && request === controller) failed = width; return }
      if (controller.signal.aborted || request !== controller || !active || !visible
        || image !== currentImage || source.value !== currentSource) {
        result.release(); return
      }
      if (lease) retired.add(lease)
      lease = result
      previewReady.value = false
      previewSrc.value = result.url
      satisfied = result.width < width || width === 3360 ? Infinity : result.width
    }).catch(() => {
      if (!controller.signal.aborted && request === controller) failed = width
    }).finally(() => {
      if (request !== controller) return
      request = undefined
      // A larger layout may have arrived while the previous image was decoding.
      if (!controller.signal.aborted && width < 3360 && requiredWidth() > width) requestPreview()
    })
  }
  function beginWatching() {
    if (!active || !image || !source.value || watching) return
    watching = true
    observeImage(image, {
      visible(value) {
        visible = value
        if (value) requestPreview()
        else { failed = 0; clearPreview() }
      },
      resize(width, height) { boxWidth = width; boxHeight = height; requestPreview() },
      density: requestPreview,
    })
  }
  function attach(element: HTMLImageElement) {
    if (image !== element) { stopWatching(); image = element; failed = 0 }
    beginWatching()
  }
  async function onPreviewLoad(event: Event) {
    const target = event.target
    if (!(target instanceof HTMLImageElement) || target.getAttribute('src') !== previewSrc.value) return
    const current = lease
    try { await target.decode() }
    catch { if (current === lease) onPreviewError(event); return }
    if (current !== lease || !target.isConnected) return
    previewReady.value = true
    releaseRetired()
  }
  function onPreviewError(event: Event) {
    const target = event.target
    if (!(target instanceof HTMLImageElement) || target.getAttribute('src') !== previewSrc.value) return
    failed = Math.min(3360, Math.ceil(requiredWidth() / 560) * 560)
    lease?.invalidate()
    clearPreview()
  }
  watch([source, () => resolveRuntimeUrl(toValue(thumbnail)), runtimeResourceIdentity], ([, thumb, identity], previous) => {
    stopWatching(); failed = 0
    if (previous && (thumb !== previous[1] || identity !== previous[2])) image = undefined
    else beginWatching()
  }, { flush: 'sync' })
  onDeactivated(() => { active = false; stopWatching() })
  onActivated(() => { active = true; beginWatching() })
  onScopeDispose(() => { active = false; stopWatching(); image = undefined })
  return { attach, preview: computed(() => ({ src: previewSrc.value, onLoad: onPreviewLoad, onError: onPreviewError })), previewReady }
}
