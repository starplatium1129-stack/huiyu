import { onMounted, onUnmounted, ref } from 'vue'

/** Desktop chrome is explicit: context menu/keyboard only, never pointer proximity. */
export function usePetGestures(bridge: Window['companionDesktop'], openChat: () => void) {
  const controlsOpen = ref(false)
  let origin: { x: number; y: number } | null = null
  let suppressClickUntil = 0
  const interactive = (target: EventTarget | null) => target instanceof Element && Boolean(target.closest('button, a, input, select, textarea, summary, .companion-toolbar, .character-controls-panel'))
  function contextMenu(event: MouseEvent) {
    if (!bridge || event.target instanceof Element && event.target.closest('input,textarea')) return
    event.preventDefault(); controlsOpen.value = !controlsOpen.value
  }
  function beginDrag(event: PointerEvent) {
    if (!bridge || event.button !== 0 || interactive(event.target)) return
    controlsOpen.value = false
    if (event.target instanceof Element && event.target.closest('.portrait-stage')) origin = { x: event.clientX, y: event.clientY }
  }
  async function move(event: PointerEvent) {
    if (!origin || !(event.buttons & 1) || !bridge?.startDragging) return
    if (Math.hypot(event.clientX - origin.x, event.clientY - origin.y) < 8) return
    origin = null; suppressClickUntil = Date.now() + 500
    event.preventDefault()
    try { await bridge.startDragging() } catch { controlsOpen.value = true }
    finally { suppressClickUntil = Date.now() + 300 }
  }
  function endDrag() { origin = null }
  function click(event: MouseEvent) {
    if (Date.now() < suppressClickUntil && !interactive(event.target)) { event.preventDefault(); event.stopPropagation() }
  }
  function doubleClick(event: MouseEvent) {
    if (!bridge || interactive(event.target) || Date.now() < suppressClickUntil) return
    event.preventDefault(); openChat()
  }
  function changed(event: Event) {
    if (bridge && event.target instanceof HTMLSelectElement && event.target.closest('.companion-toolbar .companion-picker')) {
      controlsOpen.value = false; event.target.blur()
    }
  }
  function key(event: KeyboardEvent) {
    if (!bridge) return
    if (event.key === 'Escape') controlsOpen.value = false
    if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') {
      event.preventDefault(); controlsOpen.value = !controlsOpen.value
    }
  }
  onMounted(() => { window.addEventListener('pointermove', move, { passive: false }); window.addEventListener('pointerup', endDrag); window.addEventListener('pointercancel', endDrag); window.addEventListener('keydown', key) })
  onUnmounted(() => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', endDrag); window.removeEventListener('pointercancel', endDrag); window.removeEventListener('keydown', key) })
  return { controlsOpen, contextMenu, beginDrag, click, doubleClick, changed }
}
