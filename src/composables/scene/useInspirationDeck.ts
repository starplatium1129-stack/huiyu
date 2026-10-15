import { computed, nextTick, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import { useEventListener } from '@vueuse/core'
import { useVisualActivity } from '../useVisualActivity'

/** Browsing only. Selection is a separate button; gestures never apply a filter. */
export function useInspirationDeck(host: Ref<HTMLElement | null>, keys: () => string[]) {
  const { canPresent, canAnimate } = useVisualActivity(host)
  const index = ref(0)
  const dragging = ref(false)
  const count = computed(() => keys().length)
  let pointer: { id: number; x: number; y: number; width: number; offset: number } | null = null
  let dragCard: HTMLElement | null = null
  let motion: { card: HTMLElement; animation: Animation } | null = null
  let revision = 0
  let suppressClick = false
  const wrap = (value: number) => (value + count.value) % Math.max(1, count.value)

  function presentation(card: HTMLElement) {
    const style = getComputedStyle(card)
    return { transform: style.transform, opacity: style.opacity }
  }
  function stopMotion() {
    revision++
    motion?.animation.cancel()
    motion = null
  }
  function settle(card: HTMLElement, from: { transform: string; opacity: string }) {
    if (!canAnimate.value || !card.isConnected || typeof card.animate !== 'function') return
    const style = getComputedStyle(card)
    const durationToken = style.getPropertyValue('--motion-hover').trim()
    const duration = Number.parseFloat(durationToken) * (durationToken.endsWith('ms') ? 1 : 1000)
    if (!Number.isFinite(duration) || duration <= 0) return
    const animation = card.animate([from, { transform: style.transform, opacity: 1 }], {
      duration, easing: style.getPropertyValue('--ease-out').trim() || 'ease-out',
    })
    motion = { card, animation }
    const release = () => {
      if (motion?.animation === animation) motion = null
      animation.cancel()
    }
    void animation.finished.then(release, release)
  }

  function releasePointer() {
    const id = pointer?.id
    pointer = null
    if (id !== undefined && host.value?.hasPointerCapture?.(id)) host.value.releasePointerCapture(id)
    dragging.value = false
    dragCard?.style.removeProperty('transform')
    dragCard = null
  }
  function finish() {
    stopMotion()
    releasePointer()
  }
  function step(direction: 1 | -1, instant = false) {
    if (count.value < 2 || !canPresent.value) return
    const movingCard = dragCard ?? motion?.card
    const from = movingCard ? presentation(movingCard) : { transform: `translate3d(${direction * 16}px,0,0)`, opacity: '.92' }
    const focused = host.value?.contains(document.activeElement) ? document.activeElement : null
    stopMotion()
    releasePointer()
    // Commit browsing immediately. Vue removes obsolete cards without an
    // interactive exit copy; the new primary card owns only a short visual settle.
    index.value = wrap(index.value + direction)
    const token = revision
    void nextTick(() => {
      if (token !== revision) return
      if (focused && !focused.isConnected && document.activeElement === document.body)
        host.value?.focus({ preventScroll: true })
      const card = host.value?.querySelector<HTMLElement>('.inspiration-deck-card.front')
      if (card && !instant) settle(card, from)
    })
  }
  function pointerDown(event: PointerEvent) {
    suppressClick = false
    if (!event.isPrimary || event.button !== 0 || pointer || count.value < 2 || !canPresent.value) return
    if ((event.target as Element).closest('button, a, input, select, textarea, [contenteditable="true"]')) return
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, width: host.value?.clientWidth || 400, offset: 0 }
  }
  function pointerMove(event: PointerEvent) {
    if (!pointer || pointer.id !== event.pointerId) return
    const x = event.clientX - pointer.x, y = event.clientY - pointer.y
    if (!dragging.value) {
      if (Math.abs(y) > 8 && Math.abs(y) >= Math.abs(x)) { releasePointer(); return }
      if (Math.abs(x) < 10 || Math.abs(x) < Math.abs(y) * 1.25) return
      dragCard = host.value?.querySelector<HTMLElement>('.inspiration-deck-card.front') ?? null
      if (!dragCard) { releasePointer(); return }
      pointer.offset = new DOMMatrixReadOnly(getComputedStyle(dragCard).transform).m41
      stopMotion()
      dragging.value = true
      host.value?.setPointerCapture?.(event.pointerId)
    }
    event.preventDefault()
    suppressClick = true
    // Keep the card within its local scene-atlas slot, including a narrow desktop window.
    if (dragCard && canAnimate.value)
      dragCard.style.transform = `translate3d(${Math.max(-100, Math.min(100, pointer.offset + x * 0.48))}px,0,0)`
  }
  function pointerUp(event: PointerEvent) {
    if (!pointer || pointer.id !== event.pointerId) return
    const x = event.clientX - pointer.x
    const crossed = dragging.value && Math.abs(x) >= Math.min(90, pointer.width * 0.18)
    if (crossed) step(x < 0 ? 1 : -1)
    else cancel()
  }
  function cancel(event?: PointerEvent) {
    if (!pointer || (event && event.pointerId !== pointer.id)) return
    const card = dragCard
    const from = card ? presentation(card) : null
    releasePointer()
    if (card && from) settle(card, from)
  }
  function clickCapture(event: MouseEvent) {
    if (suppressClick && event.detail !== 0) { event.preventDefault(); event.stopPropagation(); suppressClick = false }
  }
  function keydown(event: KeyboardEvent) {
    // Arrow keys belong to the focusable deck, never to nested buttons or text fields.
    if (event.key === 'Escape') { cancel(); return }
    if (event.target !== host.value || event.altKey || event.ctrlKey || event.metaKey) return
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault()
      step(event.key === 'ArrowRight' ? 1 : -1, true)
    }
  }
  // Catalog reloads clone the same rails after a search; preserve the page being read.
  watch(() => keys().join('\u0000'), () => { finish(); index.value = 0 }, { flush: 'sync' })
  watch([canPresent, canAnimate], ([present, animate]) => { if (!present || !animate) finish() }, { flush: 'sync' })
  useEventListener(window, 'blur', finish)
  useEventListener(window, 'resize', finish)
  onBeforeUnmount(finish)
  return { index, dragging, canAnimate, step, pointerDown, pointerMove,
    pointerUp, cancel, clickCapture, keydown }
}
