import { onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch, type Ref } from 'vue'

/** Own the fitted image geometry; pointer moves update only the transformed layer. */
export function useImageViewport(
  viewport: Ref<HTMLElement | null>,
  image: Ref<HTMLImageElement | null>,
  layer: Ref<HTMLElement | null>,
  limits: Readonly<{ minScale?: number; maxScale?: number }>,
) {
  const scale = ref(1), isPanning = ref(false)
  let x = 0, y = 0
  let geometry = { width: 0, height: 0, viewportWidth: 0, viewportHeight: 0 }
  let pan: { target: HTMLElement; id: number; startX: number; startY: number; x: number; y: number; ratioX: number; ratioY: number } | null = null
  let observer: ResizeObserver | null = null, active = false
  const ZOOM_STEP = .25, KEYBOARD_PAN_STEP = 32

  function paint() {
    if (layer.value) layer.value.style.transform = `translate(${x}px, ${y}px) scale(${scale.value})`
  }
  function constrain() {
    const boundX = Math.max(0, (geometry.width * scale.value - geometry.viewportWidth) / 2)
    const boundY = Math.max(0, (geometry.height * scale.value - geometry.viewportHeight) / 2)
    x = Math.max(-boundX, Math.min(boundX, x))
    y = Math.max(-boundY, Math.min(boundY, y))
    paint()
  }
  function releasePan() {
    const previous = pan
    pan = null; isPanning.value = false
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
      if (geometry.width && geometry.height) { x *= width / geometry.width; y *= height / geometry.height }
      geometry = { width, height, viewportWidth, viewportHeight }
    }
    constrain()
  }
  function resetZoom() {
    releasePan()
    scale.value = 1; x = y = 0
    paint()
  }
  function resetImage() {
    resetZoom()
    geometry = { width: 0, height: 0, viewportWidth: 0, viewportHeight: 0 }
  }
  function setScale(value: number, point?: { clientX: number; clientY: number }) {
    releasePan(); refreshBounds()
    const next = Number(Math.max(limits.minScale ?? 1, Math.min(limits.maxScale ?? 4, value)).toFixed(2))
    if (next <= 1.01) { resetZoom(); return }
    const rect = point ? viewport.value?.getBoundingClientRect() : null
    const anchorX = point && rect?.width ? (point.clientX - rect.left) * geometry.viewportWidth / rect.width - geometry.viewportWidth / 2 : 0
    const anchorY = point && rect?.height ? (point.clientY - rect.top) * geometry.viewportHeight / rect.height - geometry.viewportHeight / 2 : 0
    const ratio = next / scale.value
    x = anchorX - (anchorX - x) * ratio
    y = anchorY - (anchorY - y) * ratio
    scale.value = next
    constrain()
  }
  function zoomIn() { setScale(scale.value + ZOOM_STEP) }
  function zoomOut() { setScale(scale.value - ZOOM_STEP) }
  function toggleZoom(event: MouseEvent) {
    if (scale.value > 1.05) resetZoom()
    else setScale(2.2, event)
  }
  function handleWheel(event: WheelEvent) {
    if (event.deltaY) setScale(scale.value + (event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP), event)
  }
  function onKeydown(event: KeyboardEvent) {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey || event.target !== event.currentTarget) return
    if (event.key === '+' || event.key === '=') { event.preventDefault(); zoomIn(); return }
    if (event.key === '-') { event.preventDefault(); zoomOut(); return }
    if (event.key === 'Home') { event.preventDefault(); resetZoom(); return }
    if (scale.value <= 1.01) return
    let dx = 0, dy = 0
    if (event.key === 'ArrowLeft') dx = -KEYBOARD_PAN_STEP
    else if (event.key === 'ArrowRight') dx = KEYBOARD_PAN_STEP
    else if (event.key === 'ArrowUp') dy = -KEYBOARD_PAN_STEP
    else if (event.key === 'ArrowDown') dy = KEYBOARD_PAN_STEP
    else return
    event.preventDefault()
    releasePan(); refreshBounds()
    x += dx; y += dy
    constrain()
  }
  function startPan(event: PointerEvent) {
    if (!active || scale.value <= 1.01 || pan || event.button !== 0 || !event.isPrimary || !(event.currentTarget instanceof HTMLElement)) return
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
    constrain()
  }
  function stopPan(event: PointerEvent) { if (event.pointerId === pan?.id) releasePan() }
  function observe() {
    observer?.disconnect()
    if (!active) return
    observer ??= new ResizeObserver(refreshBounds)
    if (viewport.value) observer.observe(viewport.value)
    if (image.value) observer.observe(image.value)
    refreshBounds(); paint()
  }
  function activate() {
    if (active) return
    active = true
    window.addEventListener('blur', releasePan)
    observe()
  }
  function deactivate() {
    active = false
    releasePan(); observer?.disconnect()
    window.removeEventListener('blur', releasePan)
  }
  watch([viewport, image, layer], observe, { flush: 'post' })
  onMounted(activate); onActivated(activate)
  onDeactivated(deactivate); onBeforeUnmount(deactivate)
  return { scale, isPanning, refreshBounds, resetZoom, resetImage, zoomIn, zoomOut, toggleZoom, handleWheel, onKeydown, startPan, onPan, stopPan }
}
