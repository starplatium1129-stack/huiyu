import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import { useEventListener } from '@vueuse/core'
import { useVisualActivity } from '../useVisualActivity'

/** Browsing only. Selection is a separate button; gestures never apply a filter. */
export function useInspirationDeck(host: Ref<HTMLElement | null>, keys: () => string[]) {
  const { canPresent, canAnimate } = useVisualActivity(host)
  const index = ref(0)
  const dragX = ref(0)
  const dragging = ref(false)
  const turning = ref<0 | 1 | -1>(0)
  const resetting = ref(false)
  const count = computed(() => keys().length)
  let pointer: { id: number; x: number; y: number; width: number } | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let frame = 0
  let suppressClick = false
  const wrap = (value: number) => (value + count.value) % Math.max(1, count.value)

  function releasePointer() {
    const id = pointer?.id
    pointer = null
    if (id !== undefined && host.value?.hasPointerCapture?.(id)) host.value.releasePointerCapture(id)
    dragging.value = false
    dragX.value = 0
  }
  function finish() {
    clearTimeout(timer)
    timer = undefined
    cancelAnimationFrame(frame)
    resetting.value = true
    if (turning.value) index.value = wrap(index.value + turning.value)
    turning.value = 0
    releasePointer()
    // Reset the new primary card before resuming motion after a page turn.
    if (canAnimate.value) frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => { resetting.value = false; frame = 0 })
    })
  }
  function step(direction: 1 | -1) {
    if (count.value < 2 || turning.value || !canPresent.value) return
    releasePointer()
    if (!canAnimate.value) { index.value = wrap(index.value + direction); return }
    resetting.value = false
    turning.value = direction
    timer = setTimeout(finish, 240)
  }
  function pointerDown(event: PointerEvent) {
    suppressClick = false
    if (!event.isPrimary || event.button !== 0 || turning.value || count.value < 2 || !canPresent.value) return
    if ((event.target as Element).closest('button, a, input, select, textarea, [contenteditable="true"]')) return
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, width: host.value?.clientWidth || 400 }
  }
  function pointerMove(event: PointerEvent) {
    if (!pointer || pointer.id !== event.pointerId) return
    const x = event.clientX - pointer.x, y = event.clientY - pointer.y
    if (!dragging.value) {
      if (Math.abs(y) > 8 && Math.abs(y) >= Math.abs(x)) { releasePointer(); return }
      if (Math.abs(x) < 10 || Math.abs(x) < Math.abs(y) * 1.25) return
      dragging.value = true
      host.value?.setPointerCapture?.(event.pointerId)
    }
    event.preventDefault()
    suppressClick = true
    // Keep the card within its local scene-atlas slot, including a narrow desktop window.
    dragX.value = Math.max(-100, Math.min(100, x * 0.48))
  }
  function pointerUp(event: PointerEvent) {
    if (!pointer || pointer.id !== event.pointerId) return
    const x = event.clientX - pointer.x
    const crossed = dragging.value && Math.abs(x) >= Math.min(90, pointer.width * 0.18)
    releasePointer()
    if (crossed) step(x < 0 ? 1 : -1)
  }
  function clickCapture(event: MouseEvent) {
    if (suppressClick && event.detail !== 0) { event.preventDefault(); event.stopPropagation(); suppressClick = false }
  }
  function keydown(event: KeyboardEvent) {
    // Arrow keys belong to the focusable deck, never to nested buttons or text fields.
    if (event.key === 'Escape') { releasePointer(); return }
    if (event.target !== host.value || event.altKey || event.ctrlKey || event.metaKey) return
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault()
      step(event.key === 'ArrowRight' ? 1 : -1)
    }
  }
  // Catalog reloads clone the same rails after a search; preserve the page being read.
  watch(() => keys().join('\u0000'), () => { finish(); index.value = 0 }, { flush: 'sync' })
  watch([canPresent, canAnimate], ([present, animate]) => { if (!present || !animate) finish() }, { flush: 'sync' })
  useEventListener(window, 'blur', finish)
  useEventListener(window, 'resize', finish)
  onBeforeUnmount(() => { clearTimeout(timer); cancelAnimationFrame(frame); releasePointer() })
  return { index, dragX, dragging, turning, resetting, canAnimate, step, pointerDown, pointerMove,
    pointerUp, cancel: releasePointer, clickCapture, keydown }
}
