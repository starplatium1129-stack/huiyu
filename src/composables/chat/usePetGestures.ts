import { onMounted, onUnmounted, ref } from 'vue'
import { companionWindow } from '@/platform/desktop/capabilities'
import { useCompanionInput } from './useCompanionInput'

/** Desktop chrome is explicit: context menu/keyboard only, never pointer proximity. */
export function usePetGestures(bridge: import('@/types/desktop').CompanionDesktopBridge | undefined, openChat: () => void) {
  const controlsOpen = ref(false)
  const input = useCompanionInput()
  let origin: { x: number; y: number; pointerId: number; element: Element } | null = null
  let dragging = false
  let suppressClickUntil = 0
  const interactive = (target: EventTarget | null) => target instanceof Element && Boolean(target.closest('button, a, input, select, textarea, summary, [data-companion-interactive], .companion-toolbar, .companion-orbit, .character-controls-panel'))
  const onCharacter = (target: EventTarget | null) => target instanceof Element && target.closest('.portrait-stage, .card-portrait')
  function contextMenu(event: MouseEvent) {
    if (!bridge || interactive(event.target) || !onCharacter(event.target)) return
    event.preventDefault(); controlsOpen.value = !controlsOpen.value
  }
  function beginDrag(event: PointerEvent) {
    if (!bridge || event.button !== 0 || !event.isPrimary || dragging || interactive(event.target)) return
    const element = onCharacter(event.target)
    if (controlsOpen.value) { controlsOpen.value = false; return }
    if (!element) return
    controlsOpen.value = false
    const capture = event.target instanceof Element ? event.target : element
    capture.setPointerCapture(event.pointerId)
    origin = { x: event.clientX, y: event.clientY, pointerId: event.pointerId, element: capture }
    void input?.setDragLock(true)
  }
  async function move(event: PointerEvent) {
    if (!origin || dragging || event.pointerId !== origin.pointerId || !(event.buttons & 1) || !bridge?.startDragging) return
    if (Math.hypot(event.clientX - origin.x, event.clientY - origin.y) < 8) return
    dragging = true
    suppressClickUntil = Date.now() + 500
    event.preventDefault()
    try { await input?.setDragLock(true); if (origin) await bridge.startDragging() }
    catch { controlsOpen.value = true }
    finally { dragging = false; endDrag(); suppressClickUntil = Date.now() + 300 }
  }
  function endDrag(event?: Event) {
    if (event instanceof PointerEvent && origin && event.pointerId !== origin.pointerId) return
    const captured = origin
    origin = null
    if (captured?.element.hasPointerCapture(captured.pointerId)) captured.element.releasePointerCapture(captured.pointerId)
    void input?.setDragLock(false)
  }
  function click(event: MouseEvent) {
    if (Date.now() < suppressClickUntil && !interactive(event.target)) { event.preventDefault(); event.stopPropagation() }
  }
  function doubleClick(event: MouseEvent) {
    if (!bridge || interactive(event.target) || Date.now() < suppressClickUntil) return
    event.preventDefault(); openChat()
  }
  function key(event: KeyboardEvent) {
    if (!bridge || event.defaultPrevented || document.querySelector('dialog[open]')) return
    if (event.key === 'Escape') { controlsOpen.value = false; endDrag() }
    if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') {
      event.preventDefault(); controlsOpen.value = !controlsOpen.value
    }
  }
  const events = ['pointerup', 'pointercancel', 'lostpointercapture', 'blur'] as const
  const stop: (() => void)[] = []
  onMounted(() => {
    if (!bridge) return
    window.addEventListener('pointermove', move, { passive: false })
    for (const event of events) window.addEventListener(event, endDrag)
    window.addEventListener('keydown', key)
    stop.push(companionWindow.on('dismiss', () => { if (!document.querySelector('dialog[open]')) controlsOpen.value = false }))
    stop.push(companionWindow.on('menu', () => { controlsOpen.value = true }))
  })
  onUnmounted(() => {
    endDrag()
    stop.forEach(remove => remove())
    window.removeEventListener('pointermove', move)
    for (const event of events) window.removeEventListener(event, endDrag)
    window.removeEventListener('keydown', key)
  })
  return { controlsOpen, contextMenu, beginDrag, click, doubleClick }
}
