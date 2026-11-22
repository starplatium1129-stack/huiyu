// Lucian UX/UI Prompt #212 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#212
import { onActivated, onDeactivated, onMounted, onScopeDispose, ref, watch, type Ref } from 'vue'
import { useMotionPreference } from './useMotionPreference'

const TOP_REVEAL_MARGIN = 12

export function useScrollHeader(host: Ref<HTMLElement | null>, path: () => string, expanded: () => boolean, desktop: boolean) {
  const hidden = ref(false), scrolled = ref(false), progress = ref<HTMLElement | null>(null)
  const reduced = useMotionPreference()
  let frame = 0, attached = false
  let observer: MutationObserver | undefined
  let layout: ResizeObserver | undefined, scrollRange = 0
  let position = 0, viewportWidth = window.innerWidth
  let headerTop = 0, headerBottom = 0, pointerHeld = false
  function reveal() { hidden.value = false }
  function update() {
    frame = 0
    const sidebar = document.documentElement.dataset.themeStyle === 'terraria' && viewportWidth >= 1440
    const pinned = sidebar || ['/prompt-builder', '/chat', '/video-studio'].includes(path())
    const y = pinned ? 0 : position
    const keyboardFocus = !pinned && host.value?.contains(document.activeElement) && document.activeElement?.matches(':focus-visible')
    scrolled.value = !pinned && y > 20
    // Reveal throughout the opening range, including a restored near-top
    // position; do not strand a previously hidden header a few pixels from zero.
    if (desktop || pinned || expanded() || keyboardFocus || pointerHeld || y <= 20) hidden.value = false
    else if (y > 60) hidden.value = true
    if (progress.value) progress.value.style.transform = `scaleX(${pinned ? 0 : Math.min(1, y / Math.max(1, scrollRange))})`
  }
  function schedule() { if (attached && !frame) frame = requestAnimationFrame(update) }
  function scroll() { position = Math.max(0, window.scrollY); schedule() }
  function resize() {
    viewportWidth = window.innerWidth
    const header = host.value
    if (header) {
      // Use the sticky inset, since the transformed box is offscreen when hidden.
      headerTop = Number.parseFloat(getComputedStyle(header).top) || 0
      headerBottom = headerTop + header.offsetHeight
    }
    schedule()
  }
  function releasePointer() {
    if (!pointerHeld) return
    pointerHeld = false
    schedule()
  }
  function onPointerMove(event: PointerEvent) {
    if (event.pointerType !== 'mouse') return
    if (pointerHeld) {
      if (event.clientY > headerBottom) releasePointer()
    } else if (hidden.value && event.buttons === 0 && event.clientY <= headerTop + TOP_REVEAL_MARGIN) {
      pointerHeld = true
      schedule()
    }
  }
  function onKey(event: KeyboardEvent) { if (event.key === 'Tab') reveal() }
  function start() {
    if (attached) return
    attached = true
    window.addEventListener('scroll', scroll, { passive: true })
    window.addEventListener('resize', resize)
    if (!desktop) window.addEventListener('pointermove', onPointerMove, { capture: true, passive: true })
    document.documentElement.addEventListener('pointerleave', releasePointer)
    window.addEventListener('blur', releasePointer)
    document.addEventListener('keydown', onKey, true)
    observer = new MutationObserver(schedule)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme-style'] })
    // Route, image and async-panel size changes are measured after natural
    // layout. Scrolling and route rAF callbacks only paint the cached range.
    layout = new ResizeObserver(() => {
      scrollRange = Math.max(0, document.documentElement.scrollHeight - innerHeight)
      position = Math.max(0, window.scrollY)
      resize()
    })
    layout.observe(document.documentElement)
    layout.observe(document.body)
    if (host.value) layout.observe(host.value)
    // Let the page finish mounting before reading its scrolling geometry.
    schedule()
  }
  function stop() {
    attached = false
    cancelAnimationFrame(frame); frame = 0
    window.removeEventListener('scroll', scroll)
    window.removeEventListener('resize', resize)
    window.removeEventListener('pointermove', onPointerMove, true)
    document.documentElement.removeEventListener('pointerleave', releasePointer)
    window.removeEventListener('blur', releasePointer)
    pointerHeld = false
    document.removeEventListener('keydown', onKey, true)
    observer?.disconnect(); observer = undefined
    layout?.disconnect(); layout = undefined; scrollRange = 0
    reveal()
  }
  watch(path, () => { releasePointer(); schedule() }, { flush:'post' })
  watch(expanded, value => { if (value) reveal() })
  onMounted(start)
  onActivated(start)
  onDeactivated(stop)
  onScopeDispose(stop)
  return { hidden, scrolled, progress, reduced, reveal }
}
