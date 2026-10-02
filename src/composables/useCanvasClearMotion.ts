import { onBeforeUnmount, watch, type Ref } from 'vue'
import { useEventListener, useResizeObserver } from '@vueuse/core'
import { useVisualActivity } from './useVisualActivity'

type Dissolve = typeof import('@/utils/canvasDissolve')['startCanvasDissolve']

/** Presentation only: snapshot the displayed pixels without owning the result. */
export function useCanvasClearMotion(
  host: Ref<HTMLElement | null>, source: () => string, busy: () => boolean, comparing: () => boolean,
) {
  const { canAnimate, lowEffects } = useVisualActivity(host)
  let dissolve: Dissolve | null = null
  let loading = false
  let cleanup: (() => void) | null = null
  let hostWidth = 0
  function stop() { cleanup?.(); cleanup = null }
  // Keep the pixel algorithm outside the workbench's static bundle, ready before the usual clear click.
  watch(source, url => {
    if (!url || dissolve || loading) return
    loading = true
    void import('@/utils/canvasDissolve').then(module => { dissolve = module.startCanvasDissolve })
      .catch(() => {}).finally(() => { loading = false })
  }, { immediate: true })
  function playClear() {
    if (!source() || busy()) return stop()
    playSnapshot()
  }
  function playSnapshot() {
    stop()
    const root = host.value
    // Comparison has two independently clipped images; never replace it with an incorrect full image.
    if (!root || comparing() || !canAnimate.value || lowEffects.value) return
    const image = root.querySelector<HTMLImageElement>('img.cg-image-target')
    if (!image?.complete || !image.naturalWidth) return
    hostWidth = root.getBoundingClientRect().width
    try { cleanup = dissolve?.(image, root) ?? fadeSnapshot(image, root) }
    catch { /* A decorative effect must never prevent the synchronous clear action. */ }
  }
  watch([source, busy, comparing], ([url, generating, comparison], [oldUrl, wasGenerating]) => {
    if ((url && url !== oldUrl) || generating !== wasGenerating || comparison) stop()
  }, { flush: 'sync' })
  // Anima/Krea stash the old result before submitting. Props settle before this
  // pre-render watcher, while the decoded old image is still in the DOM. Capture
  // only its pixels; submission and result ownership never wait on the effect.
  watch([source, busy, comparing], ([url, generating, comparison], [oldUrl, , wasComparing]) => {
    if (oldUrl && !url && generating && !comparison && !wasComparing) playSnapshot()
  }, { flush: 'pre' })
  watch([canAnimate, lowEffects], () => {
    if (!canAnimate.value || lowEffects.value) stop()
  }, { flush: 'sync' })
  useEventListener(window, 'resize', stop)
  useResizeObserver(host, () => {
    if (cleanup && host.value && Math.abs(host.value.getBoundingClientRect().width - hostWidth) > 1) stop()
  })
  onBeforeUnmount(stop)
  return { playClear, stop }
}

/** A tainted canvas can still be displayed; never read pixels or alter CORS for the fallback. */
function fadeSnapshot(image: HTMLImageElement, host: HTMLElement): (() => void) | null {
  const rect = image.getBoundingClientRect(), parent = host.getBoundingClientRect()
  if (rect.width < 1 || rect.height < 1) return null
  const canvas = document.createElement('canvas')
  const ratio = Math.min(1, 1024 / Math.max(rect.width, rect.height), Math.sqrt(600_000 / (rect.width * rect.height)))
  canvas.width = Math.max(1, Math.floor(rect.width * ratio))
  canvas.height = Math.max(1, Math.floor(rect.height * ratio))
  let animation: Animation | null = null
  const release = () => { animation?.cancel(); animation = null; canvas.remove(); canvas.width = canvas.height = 0 }
  try {
    const context = canvas.getContext('2d')
    if (!context || typeof canvas.animate !== 'function') { release(); return null }
    const fit = Math.min(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight)
    const width = image.naturalWidth * fit, height = image.naturalHeight * fit
    context.drawImage(image, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height)
    canvas.setAttribute('aria-hidden', 'true')
    canvas.className = 'canvas-clear-fallback'
    Object.assign(canvas.style, {
      position: 'absolute', pointerEvents: 'none', zIndex: '2',
      left: `${rect.left - parent.left - host.clientLeft + host.scrollLeft}px`,
      top: `${rect.top - parent.top - host.clientTop + host.scrollTop}px`,
      width: `${rect.width}px`, height: `${rect.height}px`,
    })
    host.append(canvas)
    const opacity = Number.parseFloat(getComputedStyle(image).opacity)
    animation = canvas.animate([{ opacity: Number.isFinite(opacity) ? Math.max(0, Math.min(1, opacity)) : 1 }, { opacity: 0 }], { duration: 220, easing: 'ease-out', fill: 'forwards' })
    void animation.finished.then(release, release)
    return release
  } catch { release(); return null }
}
