import { onMounted, onUnmounted, ref } from 'vue'
import { companionWindow } from '@/platform/desktop/capabilities'
import type { CompanionDesktopBridge, CompanionWindowMove } from '@/types/desktop'
import { useCompanionInput } from './useCompanionInput'

interface Press {
  x: number; y: number; width: number; height: number
  pointerId: number; element: Element; handoff?: Promise<boolean>
}
const crossedThreshold = (press: Press, event: PointerEvent) => Math.hypot(event.clientX - press.x, event.clientY - press.y) >= 4
const point = (press: Press, x: number, y: number) => ({ x: x / press.width, y: y / press.height })

/** Desktop chrome is explicit: context menu/keyboard only, never pointer proximity. */
export function usePetGestures(bridge: CompanionDesktopBridge | undefined, openChat: () => void) {
  const controlsOpen = ref(false)
  const input = useCompanionInput()
  let origin: Press | null = null
  let gesture = 0
  let menuMove = false
  let suppressClick = false
  let mounted = true
  const interactive = (target: EventTarget | null) => target instanceof Element && Boolean(target.closest('button, a, input, select, textarea, summary, [data-companion-interactive], .companion-toolbar, .companion-orbit, .character-controls-panel'))
  const onCharacter = (target: EventTarget | null) => target instanceof Element && target.closest('.portrait-stage, .card-portrait')
  function contextMenu(event: MouseEvent) {
    if (!bridge || interactive(event.target) || !onCharacter(event.target)) return
    event.preventDefault(); controlsOpen.value = !controlsOpen.value
  }
  function beginDrag(event: PointerEvent) {
    if (!bridge?.startDragging || event.button !== 0 || !event.isPrimary || origin || menuMove || interactive(event.target)) return
    const element = onCharacter(event.target)
    controlsOpen.value = false
    if (!element) return
    suppressClick = false
    element.setPointerCapture(event.pointerId)
    gesture++
    origin = { x: event.clientX, y: event.clientY, width: innerWidth, height: innerHeight, pointerId: event.pointerId, element }
    void input?.setDragLock(true)
  }
  function move(event: PointerEvent) {
    const press = origin
    if (!press || press.handoff || event.pointerId !== press.pointerId || !(event.buttons & 1) || !crossedThreshold(press, event)) return
    event.preventDefault()
    suppressClick = true
    press.handoff = requestMove({ kind: 'pointer', grab: point(press, press.x, press.y) })
    void press.handoff.then(handled => { if (handled && origin === press) endDrag() })
  }
  async function requestMove(request: CompanionWindowMove) {
    if (!bridge?.startDragging) return true
    try { return await bridge.startDragging(request) }
    catch {
      if (mounted) controlsOpen.value = true
      return true // An unavailable window cannot accept a follow-up move.
    }
  }
  async function moveFromMenu() {
    if (!bridge?.startDragging || origin || menuMove) return
    gesture++
    controlsOpen.value = false
    suppressClick = true
    menuMove = true
    try { await requestMove({ kind: 'menu' }) }
    finally { menuMove = false }
  }
  function endDrag(event?: Event) {
    if (!origin || event instanceof PointerEvent && event.pointerId !== origin.pointerId) return
    const captured = origin
    origin = null
    if (captured.element.hasPointerCapture(captured.pointerId)) captured.element.releasePointerCapture(captured.pointerId)
    void input?.setDragLock(false)
    if (!(event instanceof PointerEvent) || event.type !== 'pointerup' || !crossedThreshold(captured, event)) return
    // A complete flick can precede the native command or even the first pointermove.
    // Only the matching release supplies the endpoint, never a subsequent cursor position.
    suppressClick = true
    const turn = gesture
    const released: CompanionWindowMove = {
      kind: 'released', grab: point(captured, captured.x, captured.y), end: point(captured, event.clientX, event.clientY),
    }
    void Promise.resolve(captured.handoff).then(handled => {
      if (!handled && mounted && turn === gesture) void requestMove(released)
    })
  }
  function click(event: MouseEvent) {
    if (suppressClick && !interactive(event.target)) { event.preventDefault(); event.stopPropagation() }
  }
  function doubleClick(event: MouseEvent) {
    if (!bridge || suppressClick || interactive(event.target) || !onCharacter(event.target)) return
    event.preventDefault(); openChat()
  }
  function key(event: KeyboardEvent) {
    if (!bridge || event.defaultPrevented || document.querySelector('dialog[open]')) return
    if (event.key === 'Escape') { gesture++; controlsOpen.value = false; endDrag() }
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
    mounted = false
    endDrag()
    stop.forEach(remove => remove())
    window.removeEventListener('pointermove', move)
    for (const event of events) window.removeEventListener(event, endDrag)
    window.removeEventListener('keydown', key)
  })
  return { controlsOpen, contextMenu, beginDrag, moveFromMenu, click, doubleClick }
}
