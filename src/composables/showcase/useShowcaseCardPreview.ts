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
let intersection: IntersectionObserver | undefined, resize: ResizeObserver | undefined
let densityQuery: MediaQueryList | undefined, workers = 0
const waiting = new Set<() => void>()

function watchDensity() {
  densityQuery?.removeEventListener('change', densityChanged)
  densityQuery = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
  densityQuery.addEventListener('change', densityChanged)
}
function densityChanged() {
  watchDensity()
  for (const observer of observed.values()) observer.density()
}
function observeImage(element: HTMLImageElement, observer: ImageObserver) {
  observed.set(element, observer)
  intersection ??= new IntersectionObserver(entries => {
    for (const entry of entries) observed.get(entry.target)?.visible(entry.isIntersecting)
  }, { rootMargin: '600px 0px' })
  resize ??= new ResizeObserver(entries => {
    for (const entry of entries) observed.get(entry.target)?.resize(entry.contentRect.width, entry.contentRect.height)
  })
  if (!densityQuery) watchDensity()
  intersection.observe(element); resize.observe(element)
}
function unobserveImage(element: HTMLImageElement) {
  observed.delete(element); intersection?.unobserve(element); resize?.unobserve(element)
  if (observed.size) return
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
    const response = await runtimeFetch(source, { signal: bounded })
    if (!response.ok) throw new Error('样张预览暂不可用')
    const blob = await response.blob()
    bounded.throwIfAborted()
    return await cardPreviewImage(blob, width, bounded)
  } finally {
    workers--
    for (const ready of waiting) ready()
  }
}

/** Keep the thumbnail painted while a visible card gets display-sized pixels. */
export function useShowcaseCardPreview(thumbnail: MaybeRefOrGetter<string>, original: MaybeRefOrGetter<string>) {
  const previewSrc = ref(''), previewReady = ref(false)
  const source = computed(() => resolveRuntimeUrl(toValue(original)))
  let image: HTMLImageElement | undefined, active = true, visible = false, watching = false
  let boxWidth = 0, boxHeight = 0, satisfied = 0, failed = 0
  let request: AbortController | undefined
  const retired = new Set<string>()

  function clearPreview() {
    request?.abort(); request = undefined; satisfied = 0
    if (previewSrc.value) URL.revokeObjectURL(previewSrc.value)
    for (const url of retired) URL.revokeObjectURL(url)
    retired.clear(); previewSrc.value = ''; previewReady.value = false
  }
  function stopWatching() {
    if (image && watching) unobserveImage(image)
    watching = false; visible = false; boxWidth = boxHeight = 0
    clearPreview()
  }
  function requiredWidth() {
    if (!image || !boxWidth || !boxHeight || !image.naturalHeight) return 0
    const ratio = image.naturalWidth / image.naturalHeight
    const fit = getComputedStyle(image).objectFit
    const width = fit === 'cover' ? Math.max(boxWidth, boxHeight * ratio)
      : fit === 'contain' ? Math.min(boxWidth, boxHeight * ratio) : boxWidth
    return width * (window.devicePixelRatio || 1) * 1.06
  }
  function requestPreview() {
    const required = requiredWidth(), currentImage = image, currentSource = source.value
    if (!active || !visible || !currentImage || !currentSource || !required
      || required <= currentImage.naturalWidth || required <= satisfied || request) return
    const width = Math.ceil(required / 560) * 560
    if (failed >= width) return
    const controller = new AbortController()
    request = controller
    void createPreview(currentSource, width, controller.signal).then(async result => {
      if (!result) { if (!controller.signal.aborted && request === controller) failed = width; return }
      if (controller.signal.aborted || request !== controller || !active || !visible
        || image !== currentImage || source.value !== currentSource) return
      const url = URL.createObjectURL(result.blob)
      const decoded = new Image()
      const cancel = () => decoded.removeAttribute('src')
      controller.signal.addEventListener('abort', cancel, { once: true })
      try {
        decoded.src = url
        await decoded.decode()
        controller.signal.throwIfAborted()
      } catch (error) { URL.revokeObjectURL(url); throw error }
      finally { controller.signal.removeEventListener('abort', cancel); decoded.removeAttribute('src') }
      if (request !== controller || !active || !visible || image !== currentImage || source.value !== currentSource) {
        URL.revokeObjectURL(url); return
      }
      if (previewSrc.value) retired.add(previewSrc.value)
      else previewReady.value = false
      previewSrc.value = url
      satisfied = result.width < width ? Infinity : result.width
    }).catch(() => {
      if (!controller.signal.aborted && request === controller) failed = width
    }).finally(() => {
      if (request !== controller) return
      request = undefined
      // A larger layout may have arrived while the previous image was decoding.
      if (!controller.signal.aborted && requiredWidth() > width) requestPreview()
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
  function onPreviewLoad(event: Event) {
    const target = event.target
    if (!(target instanceof HTMLImageElement) || target.getAttribute('src') !== previewSrc.value) return
    previewReady.value = true
    for (const url of retired) URL.revokeObjectURL(url)
    retired.clear()
  }
  function onPreviewError(event: Event) {
    const target = event.target
    if (!(target instanceof HTMLImageElement) || target.getAttribute('src') !== previewSrc.value) return
    failed = Math.ceil(requiredWidth() / 560) * 560
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
