// Lucian UX/UI Prompt #212 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#212
import { onActivated, onDeactivated, onMounted, onScopeDispose, ref, watch, type Ref } from 'vue'
import { useMotionPreference } from './useMotionPreference'

export function useScrollHeader(host: Ref<HTMLElement | null>, path: () => string, expanded: () => boolean) {
  const hidden = ref(false), scrolled = ref(false), progress = ref<HTMLElement | null>(null)
  const reduced = useMotionPreference()
  let last = 0, accumulated = 0, frame = 0, attached = false
  let observer: MutationObserver | undefined
  function reveal() { hidden.value = false; accumulated = 0 }
  function update() {
    frame = 0
    const y = Math.max(0, window.scrollY), delta = y - last
    last = y
    accumulated = (delta > 0) === (accumulated > 0) ? accumulated + delta : delta
    const sidebar = document.documentElement.dataset.themeStyle === 'terraria' && window.innerWidth >= 1440
    const pinned = sidebar || ['/prompt-builder', '/chat', '/video-studio'].includes(path())
    const keyboardFocus = host.value?.contains(document.activeElement) && document.activeElement?.matches(':focus-visible')
    const held = expanded() || keyboardFocus || host.value?.matches(':hover')
    scrolled.value = !pinned && y > 20
    if (pinned || held || y < 60) hidden.value = false
    else if (accumulated > 8) hidden.value = true
    else if (accumulated < -6) hidden.value = false
    const range = document.documentElement.scrollHeight - innerHeight
    if (progress.value) progress.value.style.transform = `scaleX(${pinned ? 0 : Math.min(1, y / Math.max(1, range))})`
  }
  function schedule() { if (attached && !frame) frame = requestAnimationFrame(update) }
  function onKey(event: KeyboardEvent) { if (event.key === 'Tab') reveal() }
  function start() {
    if (attached) return
    attached = true
    last = Math.max(0, window.scrollY)
    accumulated = 0
    window.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    document.addEventListener('keydown', onKey, true)
    observer = new MutationObserver(() => { reveal(); schedule() })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme-style'] })
    update()
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
  watch(path, () => { reveal(); last = Math.max(0, window.scrollY); schedule() }, { flush:'post' })
  watch(expanded, value => { if (value) reveal() })
  onMounted(start)
  onActivated(start)
  onDeactivated(stop)
  onScopeDispose(stop)
  return { hidden, scrolled, progress, reduced, reveal }
}
