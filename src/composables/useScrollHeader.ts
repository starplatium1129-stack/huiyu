// Lucian UX/UI Prompt #212 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#212
import { onActivated, onDeactivated, onMounted, onScopeDispose, ref, watch, type Ref } from 'vue'
import { useMotionPreference } from './useMotionPreference'

export function useScrollHeader(host: Ref<HTMLElement | null>, path: () => string, expanded: () => boolean) {
  const hidden = ref(false), scrolled = ref(false), progress = ref<HTMLElement | null>(null)
  const reduced = useMotionPreference()
  let frame = 0, attached = false
  let observer: MutationObserver | undefined
  function reveal() { hidden.value = false }
  function update() {
    frame = 0
    const sidebar = document.documentElement.dataset.themeStyle === 'terraria' && window.innerWidth >= 1440
    const pinned = sidebar || ['/prompt-builder', '/chat', '/video-studio'].includes(path())
    const y = pinned ? 0 : Math.max(0, window.scrollY)
    const keyboardFocus = !pinned && host.value?.contains(document.activeElement) && document.activeElement?.matches(':focus-visible')
    scrolled.value = !pinned && y > 20
    // Reveal throughout the opening range, including a restored near-top
    // position; do not strand a previously hidden header a few pixels from zero.
    if (pinned || expanded() || keyboardFocus || y <= 20) hidden.value = false
    else if (y > 60) hidden.value = true
    const range = pinned ? 0 : document.documentElement.scrollHeight - innerHeight
    if (progress.value) progress.value.style.transform = `scaleX(${pinned ? 0 : Math.min(1, y / Math.max(1, range))})`
  }
  function schedule() { if (attached && !frame) frame = requestAnimationFrame(update) }
  function onKey(event: KeyboardEvent) { if (event.key === 'Tab') reveal() }
  function start() {
    if (attached) return
    attached = true
    window.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    document.addEventListener('keydown', onKey, true)
    observer = new MutationObserver(schedule)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme-style'] })
    // Let the page finish mounting before reading its scrolling geometry.
    schedule()
  }
  function stop() {
    attached = false
    cancelAnimationFrame(frame); frame = 0
    window.removeEventListener('scroll', schedule)
    window.removeEventListener('resize', schedule)
    document.removeEventListener('keydown', onKey, true)
    observer?.disconnect(); observer = undefined
    reveal()
  }
  watch(path, schedule, { flush:'post' })
  watch(expanded, value => { if (value) reveal() })
  onMounted(start)
  onActivated(start)
  onDeactivated(stop)
  onScopeDispose(stop)
  return { hidden, scrolled, progress, reduced, reveal }
}
