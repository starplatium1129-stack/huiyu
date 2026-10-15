import { onBeforeUnmount, onDeactivated, onMounted, ref } from 'vue'
import { useEventListener } from '@vueuse/core'

function clampPosition(value: number) {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 50
}

/** Both comparison views translate a clipped image and its content in opposite
 * directions. Images retain their fit; dragging never changes layout or clip-path. */
export function useImageComparison(initialPosition: number, side: 'left' | 'right', describe: (value: number) => string) {
  const position = ref(clampPosition(initialPosition))
  const container = ref<HTMLElement | null>(null)
  const clippedLayer = ref<HTMLElement | null>(null)
  const clippedContent = ref<HTMLElement | null>(null)
  const divider = ref<HTMLElement | null>(null)
  const isDragging = ref(false)
  let pointer: { id: number; left: number; width: number } | null = null
  let displayed = position.value
  let pending = displayed
  let frame = 0

  function paint(value: number) {
    displayed = value
    const offset = side === 'left' ? value - 100 : value
    if (clippedLayer.value) clippedLayer.value.style.transform = `translateX(${offset}%)`
    if (clippedContent.value) clippedContent.value.style.transform = `translateX(${-offset}%)`
    if (divider.value) divider.value.style.transform = `translateX(calc(${value}cqw - 50%))`
    container.value?.setAttribute('aria-valuenow', String(Math.round(value)))
    container.value?.setAttribute('aria-valuetext', describe(Math.round(value)))
  }
  function flush() {
    cancelAnimationFrame(frame); frame = 0
    paint(pending)
  }
  function updateFromPointer(event: PointerEvent) {
    if (!pointer || pointer.width <= 0) return
    pending = clampPosition((event.clientX - pointer.left) / pointer.width * 100)
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; paint(pending) })
  }
  function startDrag(event: PointerEvent) {
    if (!event.isPrimary || event.button !== 0 || pointer || !container.value) return
    const rect = container.value.getBoundingClientRect()
    if (rect.width <= 0) return
    event.preventDefault()
    container.value.focus({ preventScroll: true })
    pointer = { id: event.pointerId, left: rect.left, width: rect.width }
    isDragging.value = true
    container.value.setPointerCapture(event.pointerId)
    updateFromPointer(event)
  }
  function onDrag(event: PointerEvent) {
    if (pointer?.id === event.pointerId) updateFromPointer(event)
  }
  function stopDrag(event?: PointerEvent) {
    if (!pointer || (event && pointer.id !== event.pointerId)) return
    if (event?.type === 'pointerup') updateFromPointer(event)
    const id = pointer.id
    pointer = null
    flush()
    // Only the settled semantic value enters Vue. Continuous presentation and
    // accessible slider values are written to the owning nodes once per frame.
    position.value = displayed
    isDragging.value = false
    if (container.value?.hasPointerCapture(id)) container.value.releasePointerCapture(id)
  }
  function onKeydown(event: KeyboardEvent) {
    let next: number
    if (event.key === 'ArrowLeft') next = displayed - 1
    else if (event.key === 'ArrowRight') next = displayed + 1
    else if (event.key === 'PageDown') next = displayed - 10
    else if (event.key === 'PageUp') next = displayed + 10
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = 100
    else return
    event.preventDefault()
    stopDrag()
    pending = clampPosition(next)
    flush()
    position.value = displayed
  }
  function release() { stopDrag(); cancelAnimationFrame(frame); frame = 0 }
  useEventListener(window, 'blur', release)
  useEventListener(window, 'resize', release)
  useEventListener(window, 'scroll', release, { passive: true, capture: true })
  useEventListener(document, 'visibilitychange', release)
  onMounted(() => paint(displayed))
  onDeactivated(release)
  onBeforeUnmount(release)
  return { position, container, clippedLayer, clippedContent, divider, isDragging, startDrag, onDrag, stopDrag, onKeydown }
}
