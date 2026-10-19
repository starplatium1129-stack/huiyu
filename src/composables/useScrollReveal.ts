import { getCurrentInstance, onActivated, onDeactivated, onMounted, onUnmounted } from 'vue'
import { prefersReducedMotion } from '@/utils/motionPreference'

/** Reveal content once as it enters the viewport, including late-loading collections. */
export function useScrollReveal(selector = '[data-reveal]', options?: IntersectionObserverInit) {
  const instance = getCurrentInstance()
  let observer: IntersectionObserver | null = null
  let mutations: MutationObserver | null = null
  let media: MediaQueryList | null = null
  let frame = 0
  const observed = new Set<Element>()
  const pending = new Set<Element>()
  let active = false
  let root: Element | null = null
  // Masonry moves and cached returns must not replay an already viewed card.
  const revealedKeys = new Set<string>()
  function reveal(el: Element) {
    // Vue replaces dynamic classes when card actions change. Keep visibility
    // in a separate DOM attribute so those updates cannot hide revealed content.
    el.setAttribute('data-revealed', '')
    const key = el.getAttribute('data-reveal-key')
    if (key) revealedKeys.add(key)
    observer?.unobserve(el)
    observed.delete(el)
    pending.delete(el)
  }
  function onFocus(event: Event) {
    if (!(event.target instanceof Element)) return
    const el = event.target.closest(selector)
    if (el && root?.contains(el)) reveal(el)
  }
  function targets(node: Element, visit: (el: Element) => void) {
    if (node.matches(selector)) visit(node)
    node.querySelectorAll(selector).forEach(visit)
  }
  function flush() {
    frame = 0
    if (!active || !root) return
    const reduced = prefersReducedMotion()
    for (const el of pending) {
      if (!root.contains(el) || el.hasAttribute('data-revealed')) continue
      if (reduced || !observer || revealedKeys.has(el.getAttribute('data-reveal-key') || '')) { reveal(el); continue }
      if (observed.has(el)) continue
      observed.add(el)
      observer.observe(el)
    }
    pending.clear()
  }
  function preference() {
    if (prefersReducedMotion()) for (const el of observed) reveal(el)
  }
  function onMutations(records: MutationRecord[]) {
    if (!active || !root) return
    // Filtering can remove unseen cards. Release detached targets even while an
    // addition scan is queued; moves within this root keep their observation.
    for (const record of records) for (const node of record.removedNodes) {
      if (!(node instanceof Element)) continue
      targets(node, el => {
        if (root?.contains(el)) return
        observer?.unobserve(el)
        observed.delete(el)
        pending.delete(el)
      })
    }
    // Counters, status copy and hover decoration do not introduce reveal targets.
    // Queue only new targets, rather than rescanning the page on every batch.
    for (const record of records) for (const node of record.addedNodes) {
      if (node instanceof Element && root.contains(node)) targets(node, el => pending.add(el))
    }
    if (pending.size && !frame) frame = requestAnimationFrame(flush)
  }
  function start() {
    if (active) return
    active = true
    const element = instance?.proxy?.$el
    root = element instanceof Element ? element : document.querySelector('main') || document.body
    media = matchMedia('(prefers-reduced-motion: reduce)')
    if ('IntersectionObserver' in window) observer = new IntersectionObserver(entries => {
      entries.forEach(entry => { if (active && root?.contains(entry.target) && entry.isIntersecting) reveal(entry.target) })
    }, { threshold: 0.04, rootMargin: '0px 0px -24px 0px', ...options })
    media.addEventListener('change', preference)
    window.addEventListener('atelier:motion-preference', preference)
    root.addEventListener('focusin', onFocus)
    mutations = new MutationObserver(onMutations)
    mutations.observe(root, { childList: true, subtree: true })
    targets(root, el => pending.add(el))
    flush()
  }
  function stop() {
    active = false
    observer?.disconnect(); mutations?.disconnect(); media?.removeEventListener('change', preference); cancelAnimationFrame(frame)
    window.removeEventListener('atelier:motion-preference', preference)
    root?.removeEventListener('focusin', onFocus)
    observer = null; mutations = null; root = null; frame = 0
    observed.clear(); pending.clear()
  }
  onMounted(start)
  onActivated(start)
  onDeactivated(stop)
  onUnmounted(stop)
}
