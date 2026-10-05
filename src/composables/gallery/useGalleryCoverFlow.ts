import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch, type Ref } from 'vue'
import { useEventListener, useResizeObserver } from '@vueuse/core'
import { FluidSpring } from '@/utils/fluidSpring'
import { listenMotionChanges, prefersReducedMotion } from '@/utils/motionPreference'

/** One bounded axis for this viewer; image reads remain owned by useGalleryViewer. */
export function useGalleryCoverFlow(host: Ref<HTMLElement | null>, options: {
  index: () => number; count: () => number; active: () => boolean; select: (index: number) => void
}) {
  const position = ref(options.index()), width = ref(800), reduced = ref(prefersReducedMotion()), dragging = ref(false)
  const spring = new FluidSpring(position.value, 4.4)
  const stepWidth = computed(() => Math.max(96, Math.min(220, width.value * .18)))
  let frame = 0, lastFrame = 0
  let wheelPosition: number | null = null, wheelTimer: ReturnType<typeof setTimeout> | undefined
  let requestedIndex = options.index(), suppressClick = false
  let clickTimer: ReturnType<typeof setTimeout> | undefined
  let stopPreference: (() => void) | undefined
  let drag: { id: number; x: number; position: number; last: number; time: number; velocity: number } | null = null
  const clamp = (value: number) => Math.max(0, Math.min(Math.max(0, options.count() - 1), value))
  function stopFrame() { cancelAnimationFrame(frame); frame = 0; lastFrame = 0 }
  function tick(time: number) {
    frame = 0
    const elapsed = lastFrame ? (time - lastFrame) / 1000 : 1 / 60
    lastFrame = time
    position.value = spring.step(elapsed)
    if (!spring.settled && options.active()) frame = requestAnimationFrame(tick)
    else lastFrame = 0
  }
  function moveTo(value: number) {
    spring.to(clamp(value))
    if (reduced.value || document.hidden) { stopFrame(); spring.snap(); position.value = spring.value }
    else if (!frame) frame = requestAnimationFrame(tick)
  }
  function clearWheel() { clearTimeout(wheelTimer); wheelPosition = null }
  function releasePointer() {
    const id = drag?.id
    drag = null; dragging.value = false
    if (id !== undefined && host.value?.hasPointerCapture(id)) host.value.releasePointerCapture(id)
  }
  function stop() {
    stopFrame(); clearWheel(); releasePointer()
    clearTimeout(clickTimer); suppressClick = false
  }
  function reset() {
    stop(); requestedIndex = options.index()
    spring.snap(options.index()); position.value = spring.value
  }
  function commit(index: number) {
    requestedIndex = clamp(Math.round(index))
    if (requestedIndex !== options.index()) options.select(requestedIndex)
  }
  function select(index: number) {
    if (!options.active()) return
    clearWheel(); releasePointer(); moveTo(index); commit(index)
  }
  function blocked(target: EventTarget | null) {
    return target instanceof Element && !!target.closest('.zoom-toolbar, .gallery-orbit-caption, .zoomable-image-viewer.is-zoomed')
  }
  function pointerDown(event: PointerEvent) {
    if (!options.active() || options.count() < 2 || event.button !== 0 || blocked(event.target)) return
    clearWheel()
    drag = { id: event.pointerId, x: event.clientX, position: position.value, last: position.value, time: event.timeStamp, velocity: 0 }
  }
  function pointerMove(event: PointerEvent) {
    if (!drag || drag.id !== event.pointerId) return
    const distance = drag.x - event.clientX
    if (!dragging.value && Math.abs(distance) < 6) return
    if (!dragging.value) {
      dragging.value = true; stopFrame()
      host.value?.setPointerCapture(event.pointerId)
      host.value?.focus({ preventScroll: true })
    }
    event.preventDefault()
    const raw = drag.position + distance / stepWidth.value, bounded = clamp(raw), extra = raw - bounded
    const value = bounded + extra * .18 / (1 + Math.abs(extra))
    const elapsed = event.timeStamp - drag.time
    if (elapsed > 0) drag.velocity = Math.max(-14, Math.min(14, (value - drag.last) / elapsed * 1000))
    drag.last = value; drag.time = event.timeStamp
    spring.snap(value); position.value = value
  }
  function pointerEnd(event: PointerEvent, cancelled = false) {
    if (!drag || drag.id !== event.pointerId) return
    const wasDragging = dragging.value
    const velocity = event.timeStamp - drag.time > 80 ? 0 : drag.velocity
    releasePointer()
    if (!wasDragging) return
    if (cancelled) { moveTo(options.index()); return }
    // Project at most one extra cover, then keep the release velocity in the spring.
    const target = clamp(Math.round(position.value + Math.max(-1, Math.min(1, velocity * .12))))
    spring.velocity = velocity; moveTo(target); commit(target)
    suppressClick = true
    clickTimer = setTimeout(() => { suppressClick = false }, 0)
  }
  function wheel(event: WheelEvent) {
    if (!options.active() || options.count() < 2 || dragging.value || event.ctrlKey || event.metaKey || blocked(event.target)) return
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
    if (!delta) return
    event.preventDefault(); event.stopPropagation()
    const pixels = delta * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? width.value : 1)
    wheelPosition = clamp((wheelPosition ?? spring.target) + Math.max(-1, Math.min(1, pixels / stepWidth.value)))
    moveTo(wheelPosition); commit(wheelPosition)
    clearTimeout(wheelTimer)
    wheelTimer = setTimeout(() => { wheelPosition = null; moveTo(options.index()) }, 120)
  }
  useEventListener(host, 'pointerdown', pointerDown)
  useEventListener(host, 'pointermove', pointerMove)
  useEventListener(host, 'pointerup', event => pointerEnd(event))
  useEventListener(host, 'pointercancel', event => pointerEnd(event, true))
  useEventListener(host, 'lostpointercapture', event => pointerEnd(event, true))
  useEventListener(host, 'click', event => { if (suppressClick) { event.preventDefault(); event.stopPropagation(); suppressClick = false } }, { capture: true })
  useEventListener(host, 'wheel', wheel, { passive: false, capture: true })
  useEventListener(window, 'blur', () => { if (drag) { releasePointer(); moveTo(options.index()) } })
  useResizeObserver(host, entries => { width.value = entries[0]?.contentRect.width || width.value })
  watch(options.index, index => {
    if (!options.active()) return
    if (index !== requestedIndex) { clearWheel(); releasePointer(); moveTo(index); requestedIndex = index }
    else if (wheelPosition === null && !dragging.value) moveTo(index)
  })
  watch([options.active, options.count], reset)
  function preference() { reduced.value = prefersReducedMotion(); if (reduced.value || document.hidden) reset() }
  function activate() { reduced.value = prefersReducedMotion(); stopPreference ??= listenMotionChanges(preference); reset() }
  function deactivate() { stop(); stopPreference?.(); stopPreference = undefined }
  onMounted(activate); onActivated(activate); onDeactivated(deactivate); onBeforeUnmount(deactivate)
  return { position, width, reduced, dragging, select, reset }
}
