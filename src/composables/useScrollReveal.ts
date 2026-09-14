import { getCurrentInstance, onActivated, onDeactivated, onMounted, onUnmounted } from 'vue'
import { prefersReducedMotion } from '@/utils/motionPreference'

/** Reveal content once as it enters the viewport, including late-loading collections. */
export function useScrollReveal(selector = '[data-reveal]', options?: IntersectionObserverInit) {
  const instance = getCurrentInstance()
  let observer: IntersectionObserver | null = null
  let mutations: MutationObserver | null = null
  let media: MediaQueryList | null = null
  let frame = 0
  let seen = new WeakSet<Element>()
  let active = false
  let root: Element | null = null
  function observeAll() {
    if (!active || !root) return
    const elements = [...root.querySelectorAll(selector)]
    if (root.matches(selector)) elements.unshift(root)
    elements.forEach(el => {
      if (prefersReducedMotion() || !observer) { el.classList.add('revealed'); observer?.unobserve(el); return }
      if (seen.has(el) || el.classList.contains('revealed')) return
      seen.add(el)
      observer.observe(el)
    })
  }
  function schedule() { if (!active || frame) return; frame = requestAnimationFrame(() => { frame = 0; observeAll() }) }
  function start() {
    if (active) return
    active = true
    const element = instance?.proxy?.$el
    root = element instanceof Element ? element : document.querySelector('main') || document.body
    seen = new WeakSet()
    media = matchMedia('(prefers-reduced-motion: reduce)')
    if ('IntersectionObserver' in window) observer = new IntersectionObserver(entries => {
      entries.forEach(entry => { if (entry.isIntersecting) { entry.target.classList.add('revealed'); observer?.unobserve(entry.target) } })
    }, { threshold: 0.04, rootMargin: '0px 0px -24px 0px', ...options })
    media.addEventListener('change', observeAll)
    window.addEventListener('atelier:motion-preference', observeAll)
    mutations = new MutationObserver(schedule)
    mutations.observe(root, { childList: true, subtree: true })
    observeAll()
  }
  function stop() {
    active = false
    observer?.disconnect(); mutations?.disconnect(); media?.removeEventListener('change', observeAll); cancelAnimationFrame(frame)
    window.removeEventListener('atelier:motion-preference', observeAll)
    observer = null; mutations = null; root = null; frame = 0
  }
  onMounted(start)
  onActivated(start)
  onDeactivated(stop)
  onUnmounted(stop)
  return { observeAll }
}
