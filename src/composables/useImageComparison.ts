import { computed, ref } from 'vue'

function clampPosition(value: number) {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 50
}

/** Shared input rules; each comparison keeps its own image layers and direction. */
export function useImageComparison(initialPosition: number) {
  const position = ref(clampPosition(initialPosition))
  const container = ref<HTMLElement | null>(null)
  const activePointer = ref<number | null>(null)
  const isDragging = computed(() => activePointer.value !== null)

  function updateFromPointer(event: PointerEvent) {
    const rect = container.value?.getBoundingClientRect()
    if (rect && rect.width > 0) position.value = clampPosition((event.clientX - rect.left) / rect.width * 100)
  }

  function startDrag(event: PointerEvent) {
    if (event.button !== 0 || activePointer.value !== null || !container.value) return
    event.preventDefault()
    container.value.focus({ preventScroll: true })
    activePointer.value = event.pointerId
    container.value.setPointerCapture(event.pointerId)
    updateFromPointer(event)
  }

  function onDrag(event: PointerEvent) {
    if (activePointer.value === event.pointerId) updateFromPointer(event)
  }

  function stopDrag(event: PointerEvent) {
    if (activePointer.value !== event.pointerId) return
    activePointer.value = null
    if (container.value?.hasPointerCapture(event.pointerId)) container.value.releasePointerCapture(event.pointerId)
  }

  function onKeydown(event: KeyboardEvent) {
    let next: number
    if (event.key === 'ArrowLeft') next = position.value - 1
    else if (event.key === 'ArrowRight') next = position.value + 1
    else if (event.key === 'PageDown') next = position.value - 10
    else if (event.key === 'PageUp') next = position.value + 10
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = 100
    else return
    event.preventDefault()
    position.value = clampPosition(next)
  }

  return { position, container, isDragging, startDrag, onDrag, stopDrag, onKeydown }
}
