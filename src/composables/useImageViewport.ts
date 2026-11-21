import { onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch, type Ref } from 'vue'
import { cancelFrame, frame } from 'motion'
import { createFluidMotion } from '@/utils/fluidSpring'
import { prefersReducedMotion } from '@/utils/motionPreference'

/** Film push-in spring for discrete dblclick / button zoom actions. */
const ZOOM_SPRING = { frequency: 5.2, damping: 0.92 } as const

/** Own the fitted image geometry; pointer moves update only the transformed layer. */
export function useImageViewport(
  viewport: Ref<HTMLElement | null>,
  image: Ref<HTMLImageElement | null>,
  layer: Ref<HTMLElement | null>,
  limits: Readonly<{ minScale?: number; maxScale?: number }>,
) {
  const scale = ref(1), isPanning = ref(false)
  let x = 0, y = 0
  let liveX = 0, liveY = 0, liveScale = 1
  let geometry = { width: 0, height: 0, viewportWidth: 0, viewportHeight: 0 }
  let pan: { target: HTMLElement; id: number; startX: number; startY: number; x: number; y: number; ratioX: number; ratioY: number } | null = null
  let zoomSpring: ReturnType<typeof createFluidMotion> | undefined
  let observer: ResizeObserver | null = null, active = false
  const ZOOM_STEP = 0.25, KEYBOARD_PAN_STEP = 32

  function paintTransform(tx: number, ty: number, ts: number) {
    if (layer.value) layer.value.style.transform = `translate(${tx}px, ${ty}px) scale(${ts})`
  }
  function paint() {
    cancelFrame(paint)
    liveX = x; liveY = y; liveScale = scale.value
    paintTransform(liveX, liveY, liveScale)
  }
  function clampOffsets(tx: number, ty: number, ts: number) {
    const boundX = Math.max(0, (geometry.width * ts - geometry.viewportWidth) / 2)
    const boundY = Math.max(0, (geometry.height * ts - geometry.viewportHeight) / 2)
    return {
      x: Math.max(-boundX, Math.min(boundX, tx)),
      y: Math.max(-boundY, Math.min(boundY, ty)),
    }
  }
  function interruptSpring(adoptLivePose = true) {
    if (!zoomSpring) return
    zoomSpring.dispose()
    zoomSpring = undefined
    if (!adoptLivePose) return
    const minScale = limits.minScale ?? 1
    const maxScale = limits.maxScale ?? 4
    const adoptedScale = Number(Math.max(minScale, Math.min(maxScale, liveScale)).toFixed(2))
    if (adoptedScale <= 1.01) {
      scale.value = 1; x = 0; y = 0
      liveX = 0; liveY = 0; liveScale = 1
    } else {
      const clamped = clampOffsets(liveX, liveY, adoptedScale)
      scale.value = adoptedScale
      x = liveX = clamped.x
      y = liveY = clamped.y
      liveScale = adoptedScale
    }
  }
  function constrain(deferPaint = false) {
    const clamped = clampOffsets(x, y, scale.value)
    x = clamped.x; y = clamped.y
    if (deferPaint) frame.render(paint)
    else paint()
  }
  function animateTo(nextX: number, nextY: number, nextScale: number) {
    cancelFrame(paint)
    const clamped = clampOffsets(nextX, nextY, nextScale)
    x = clamped.x; y = clamped.y; scale.value = nextScale
    if (!active || prefersReducedMotion() || document.hidden || typeof requestAnimationFrame !== 'function') {
      interruptSpring(false)
      paint()
      return
    }
    zoomSpring ??= createFluidMotion([liveX, liveY, liveScale], ([nx, ny, ns]) => {
      liveX = nx; liveY = ny; liveScale = ns
      paintTransform(nx, ny, ns)
    }, ZOOM_SPRING.frequency, ZOOM_SPRING.damping)
    const current = zoomSpring
    current.to([x, y, scale.value], false, () => {
      if (zoomSpring === current) {
        zoomSpring.dispose()
        zoomSpring = undefined
      }
      liveX = x; liveY = y; liveScale = scale.value
      paintTransform(liveX, liveY, liveScale)
    })
  }
  function releasePan() {
    const previous = pan
    pan = null; isPanning.value = false
    if (previous) paint()
    if (previous?.target.hasPointerCapture(previous.id)) previous.target.releasePointerCapture(previous.id)
  }
  function refreshBounds() {
    const host = viewport.value, picture = image.value
    if (!active || !host?.isConnected || !picture?.naturalWidth || !picture.naturalHeight) return
    // client dimensions ignore our transform and ancestor cover-flow transforms.
    // The image element can contain letterboxing; constrain the painted picture.
    const viewportWidth = host.clientWidth, viewportHeight = host.clientHeight
    const fittedScale = Math.min(picture.clientWidth / picture.naturalWidth, picture.clientHeight / picture.naturalHeight)
    if (!viewportWidth || !viewportHeight || !fittedScale) return
    const width = picture.naturalWidth * fittedScale, height = picture.naturalHeight * fittedScale
    if (width !== geometry.width || height !== geometry.height || viewportWidth !== geometry.viewportWidth || viewportHeight !== geometry.viewportHeight) {
      // Preserve the normalized picture position through resizing and an original
      // replacing its preview. Finish capture before its coordinate basis changes.
      releasePan()
      interruptSpring(false)
      if (geometry.width && geometry.height) { x *= width / geometry.width; y *= height / geometry.height }
      geometry = { width, height, viewportWidth, viewportHeight }
      constrain()
    } else if (!zoomSpring) {
      constrain()
    }
  }
  function applyReset(animated: boolean) {
    releasePan()
    if (animated) {
      animateTo(0, 0, 1)
    } else {
      interruptSpring(false)
      scale.value = 1; x = y = 0
      paint()
    }
  }
  function resetZoom() { applyReset(true) }
  function resetImage() {
    applyReset(false)
    geometry = { width: 0, height: 0, viewportWidth: 0, viewportHeight: 0 }
  }
  function setScale(value: number, point?: { clientX: number; clientY: number }, animated = false) {
    releasePan()
    if (!animated) interruptSpring(true)
    refreshBounds()
    const next = Number(Math.max(limits.minScale ?? 1, Math.min(limits.maxScale ?? 4, value)).toFixed(2))
    if (next <= 1.01) { applyReset(animated); return }
    const rect = point ? viewport.value?.getBoundingClientRect() : null
    const anchorX = point && rect?.width ? (point.clientX - rect.left) * geometry.viewportWidth / rect.width - geometry.viewportWidth / 2 : 0
    const anchorY = point && rect?.height ? (point.clientY - rect.top) * geometry.viewportHeight / rect.height - geometry.viewportHeight / 2 : 0
    const ratio = next / scale.value
    const nextX = anchorX - (anchorX - x) * ratio
    const nextY = anchorY - (anchorY - y) * ratio
    if (animated) {
      animateTo(nextX, nextY, next)
    } else {
      x = nextX; y = nextY; scale.value = next
      constrain()
    }
  }
  function zoomIn() { setScale(scale.value + ZOOM_STEP, undefined, true) }
  function zoomOut() { setScale(scale.value - ZOOM_STEP, undefined, true) }
  function toggleZoom(event: MouseEvent) {
    if (scale.value > 1.05) applyReset(true)
    else setScale(2.2, event, true)
  }
  function containsImagePoint(point: { clientX: number; clientY: number }) {
    const rect = viewport.value?.getBoundingClientRect()
    if (!active || !geometry.width || !geometry.height || !rect?.width || !rect.height
      || point.clientX < rect.left || point.clientX > rect.right || point.clientY < rect.top || point.clientY > rect.bottom) return false
    // Use the fitted picture, including its live pan/zoom, rather than the
    // full-size <img> box whose object-contain letterboxing is still a hit target.
    const localX = (point.clientX - rect.left) * geometry.viewportWidth / rect.width - geometry.viewportWidth / 2
    const localY = (point.clientY - rect.top) * geometry.viewportHeight / rect.height - geometry.viewportHeight / 2
    return Math.abs(localX - liveX) <= geometry.width * liveScale / 2
      && Math.abs(localY - liveY) <= geometry.height * liveScale / 2
  }
  function handleWheel(event: WheelEvent) {
    if (!event.deltaY) return
    interruptSpring(true)
    setScale(scale.value + (event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP), event, false)
  }
  function onKeydown(event: KeyboardEvent) {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey || event.target !== event.currentTarget) return
    if (event.key === '+' || event.key === '=') { event.preventDefault(); interruptSpring(true); setScale(scale.value + ZOOM_STEP, undefined, false); return }
    if (event.key === '-') { event.preventDefault(); interruptSpring(true); setScale(scale.value - ZOOM_STEP, undefined, false); return }
    if (event.key === 'Home') { event.preventDefault(); applyReset(false); return }
    let dx = 0, dy = 0
    if (event.key === 'ArrowLeft') dx = -KEYBOARD_PAN_STEP
    else if (event.key === 'ArrowRight') dx = KEYBOARD_PAN_STEP
    else if (event.key === 'ArrowUp') dy = -KEYBOARD_PAN_STEP
    else if (event.key === 'ArrowDown') dy = KEYBOARD_PAN_STEP
    else return
    interruptSpring(true)
    if (scale.value <= 1.01) return
    event.preventDefault()
    releasePan(); refreshBounds()
    x += dx; y += dy
    constrain()
  }
  function startPan(event: PointerEvent) {
    if (!active || pan || event.button !== 0 || !event.isPrimary || !(event.currentTarget instanceof HTMLElement)) return
    interruptSpring(true)
    if (scale.value <= 1.01) return
    refreshBounds()
    const rect = viewport.value?.getBoundingClientRect()
    if (!rect?.width || !rect.height || !geometry.width) return
    pan = { target: event.currentTarget, id: event.pointerId, startX: event.clientX, startY: event.clientY, x, y,
      ratioX: geometry.viewportWidth / rect.width, ratioY: geometry.viewportHeight / rect.height }
    pan.target.setPointerCapture(event.pointerId)
    pan.target.focus({ preventScroll: true })
    isPanning.value = true
    event.preventDefault()
  }
  function onPan(event: PointerEvent) {
    if (!pan || event.pointerId !== pan.id) return
    x = pan.x + (event.clientX - pan.startX) * pan.ratioX
    y = pan.y + (event.clientY - pan.startY) * pan.ratioY
    // Pointer samples share one painted frame; settled/keyboard operations stay immediate.
    constrain(true)
  }
  function stopPan(event: PointerEvent) { if (event.pointerId === pan?.id) releasePan() }
  function observe() {
    observer?.disconnect()
    if (!active) return
    observer ??= new ResizeObserver(refreshBounds)
    if (viewport.value) observer.observe(viewport.value)
    if (image.value) observer.observe(image.value)
    refreshBounds()
    if (!zoomSpring) paint()
  }
  function activate() {
    if (active) return
    active = true
    window.addEventListener('blur', releasePan)
    observe()
  }
  function deactivate() {
    active = false
    interruptSpring(false)
    releasePan(); observer?.disconnect()
    cancelFrame(paint)
    window.removeEventListener('blur', releasePan)
  }
  watch([viewport, image, layer], observe, { flush: 'post' })
  onMounted(activate); onActivated(activate)
  onDeactivated(deactivate); onBeforeUnmount(deactivate)
  return { scale, isPanning, refreshBounds, resetZoom, resetImage, zoomIn, zoomOut, toggleZoom, containsImagePoint, handleWheel, onKeydown, startPan, onPan, stopPan }
}
