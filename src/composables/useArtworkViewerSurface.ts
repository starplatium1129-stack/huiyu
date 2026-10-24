import { nextTick, onDeactivated, onUnmounted, readonly, shallowRef, watch } from 'vue'
import { useFluidSurface, type SurfaceLayers } from './useFluidSurface'
import { useImageOriginTransition } from './useImageOriginTransition'
const VIEWER_IMAGE_SELECTOR = '.zoomable-img, .image-compare-slider .after-img, .pswp__item[aria-hidden="false"] .pswp__img:not(.pswp__img--placeholder)'
const HANDOFF_WINDOW = 180
type ImageKey = string | number

interface ViewerOptions {
  active: () => boolean
  /** Stable artwork identity: metadata hydration and original URLs do not change it. */
  imageKey: () => ImageKey | null | undefined
  source?: (key: ImageKey) => HTMLImageElement | null
  mode: () => string | boolean
}

/** Viewer-only choreography stays outside ordinary form/popover dependencies.
 * The surface owns every effect, including partial setup and interrupted exits. */
const animateLayers: SurfaceLayers = (el, opacity, timing, target, add) => {
  for (const part of el.querySelectorAll<HTMLElement>('.viewer-info,.viewer-close,.viewer-nav,.viewer-mode-switch,.viewer-info-toggle,.viewer-compare-toggle,.viewer-position,.zoom-toolbar,.gallery-orbit-caption,[data-viewer-chrome]')) {
    const base = getComputedStyle(part).transform
    const frames = opacity.map(({ opacity: value }) => {
      const progress = Math.max(0, Math.min(1, (value - .24) / .76))
      // The narrow information drawer keeps owning its horizontal transform.
      return { opacity: progress, ...(part.matches('.viewer-info') ? {} : {
        transform: `${base === 'none' ? '' : base} translateY(${(1 - progress) * 10}px)`,
      }) }
    })
    add(part.animate(frames, timing))
  }
  // Neighbor covers leave with the scrim. A missing return origin keeps a plain
  // image fade; the source-to-image proxy itself remains opaque during flight.
  const returning = target === 0 && el.querySelector('[data-image-origin-direction="leave"]')
  const pictures = '.gallery-orbit-card:not(.is-current)' + (returning ? '' : ',.zoom-viewport,.image-compare-slider,.pswp__scroll-wrap')
    + (target === 0 && !returning ? ',[data-image-origin-proxy]' : '')
  for (const part of el.querySelectorAll<HTMLElement>(pictures)) add(part.animate(opacity, timing))
}

/** Own the entire thumbnail/viewer handoff. Pages supply identity, content and
 * origin lookup; neither load events nor page data updates control its timeline. */
export function useArtworkViewerSurface(options: ViewerOptions) {
  const surface = useFluidSurface(undefined, { layers: animateLayers })
  const origin = useImageOriginTransition({ proxyPixelBudget: 1920 * 1080 })
  const previewSrc = shallowRef('')
  let captured: { key: ImageKey; image: HTMLImageElement | null } | null = null
  let pending: { key: ImageKey; deadline: number } | null = null
  let currentKey: ImageKey | null = null
  let host: HTMLElement | null = null
  let leaving = false, disposed = false, revision = 0
  let unbind: (() => void) | undefined

  function interrupt() { pending = null; origin.cancel() }
  function captureOrigin(image: HTMLImageElement | null, key: ImageKey) {
    revision++
    // A different work cannot borrow a previous work's frame or velocity.
    if (captured?.key !== key) interrupt()
    captured = { key, image }
    previewSrc.value = origin.capture(image)
    pending = previewSrc.value ? { key, deadline: performance.now() + HANDOFF_WINDOW } : null
  }
  function tryEnter() {
    if (!pending || !host || leaving || disposed || !options.active() || pending.key !== options.imageKey()) return
    if (performance.now() >= pending.deadline) { pending = null; return }
    const image = host.querySelector<HTMLImageElement>(VIEWER_IMAGE_SELECTOR)
    // Cached images can fire load after the surface's enter hook. Retry only
    // inside the original handoff window, never hide an already painted image.
    if (!image?.complete || !image.naturalWidth) return
    pending = null
    void origin.enter(image, host)
  }
  function mediaEvent(event: Event) {
    if (event.target !== host?.querySelector(VIEWER_IMAGE_SELECTOR)) return
    if (event.type === 'load') tryEnter()
    else interrupt()
  }
  function interact(event: Event) {
    // Escape/Tab belong to modal closing/focus and must preserve a reversible
    // flight. Only image manipulation cancels it before its geometry changes.
    if (event instanceof KeyboardEvent && (event.ctrlKey || event.metaKey || event.altKey || event.isComposing
      || !['+', '=', '-', 'Home', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', ' '].includes(event.key))) return
    if (event.target instanceof Element && event.target.closest('.gallery-orbit,.zoomable-image-viewer,.image-compare-slider,.photoswipe-stage')) interrupt()
  }
  function bind(element: HTMLElement) {
    unbind?.(); host = element
    element.addEventListener('load', mediaEvent, true)
    element.addEventListener('error', mediaEvent, true)
    for (const type of ['pointerdown', 'wheel', 'keydown']) element.addEventListener(type, interact, true)
    unbind = () => {
      element.removeEventListener('load', mediaEvent, true)
      element.removeEventListener('error', mediaEvent, true)
      for (const type of ['pointerdown', 'wheel', 'keydown']) element.removeEventListener(type, interact, true)
      unbind = undefined
    }
  }
  // Watch logical identity only. Summary-to-detail hydration, favorites and
  // decoded original upgrades belong to useViewerImage and keep this flight.
  watch([options.active, options.imageKey], ([active, key], previous) => {
    if (!active || key == null) { if (previous?.[0]) pending = null; return }
    if (key !== currentKey && key !== captured?.key) { interrupt(); previewSrc.value = '' }
    currentKey = key
  }, { immediate: true })
  watch(options.mode, () => { if (options.active() && host && !leaving) interrupt() }, { flush: 'sync' })
  onDeactivated(() => { interrupt(); unbind?.(); host = null; captured = null; previewSrc.value = '' })
  onUnmounted(() => {
    // The low-level flight and surface retain a native dialog's inert exit
    // lease until it completes, even if its business component unmounts now.
    disposed = true; pending = null; unbind?.(); host = null; captured = null
  })
  return {
    ...surface,
    previewSrc: readonly(previewSrc),
    captureOrigin,
    enter(el: Element, done: () => void) {
      const token = ++revision
      currentKey = options.imageKey() ?? currentKey
      leaving = false; bind(el as HTMLElement)
      surface.enter(el, done)
      tryEnter()
      void nextTick(() => { if (token === revision) tryEnter() })
    },
    leave(el: Element, done: () => void) {
      const token = ++revision
      pending = null; leaving = true; unbind?.()
      // Native focus closes now; only the inert exit picture flies back.
      const image = el.querySelector<HTMLImageElement>(VIEWER_IMAGE_SELECTOR)
      const key = currentKey
      // Return to the actual clicked thumbnail while it exists. After browsing
      // another work (or list virtualization), resolve that work's live origin.
      const source = captured?.key === key && captured.image?.isConnected ? captured.image
        : key == null ? null : options.source?.(key) ?? null
      if (image) void origin.leave(image, el as HTMLElement, source)
      else origin.cancel()
      surface.leave(el, () => {
        // A stale exit must not clear the next opening's warm frame or proxy.
        if (token === revision) { origin.cancel(); host = null; captured = null; previewSrc.value = '' }
        done()
      })
    },
  }
}
