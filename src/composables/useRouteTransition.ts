import { onDeactivated, onMounted, onUnmounted } from 'vue'
import { prefersReducedMotion } from '@/utils/motionPreference'
import { markUiFluidityForPath } from '@/utils/uiFluidityMeasurement'

/** Keep content opaque and release animation effects so fixed toolbars stay viewport-bound. */
export function useRouteTransition(destinationPath?: () => string) {
  const active = new Map<HTMLElement, () => void>()
  let departingPath = ''
  const pathname = (path: string) => path.split(/[?#]/, 1)[0]
  const archivePair = (from: string, to: string) => (from === '/popular-scenes' && to === '/character')
    || (from === '/character' && to === '/popular-scenes')
  function settle(el: HTMLElement) { active.get(el)?.() }
  function settleAll() { for (const finish of [...active.values()]) finish() }

  function onEnter(element: Element, done: () => void) {
    const el = element as HTMLElement
    const path = el.dataset.routePath || ''
    settle(el)
    el.inert = false
    if (path) markUiFluidityForPath(path, 'shell-ready')
    const cachedActivation = el.dataset.routeEntered === 'true'
    el.dataset.routeEntered = 'true'
    // KeepAlive returns reuse the same physical page. Replaying first-entry motion makes
    // back/forward feel slower and can blur content that was already ready.
    if (cachedActivation || prefersReducedMotion() || typeof el.animate !== 'function') {
      if (path) markUiFluidityForPath(path, 'settled')
      done()
      return
    }
    let animation: Animation | undefined
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      active.delete(el)
      if (animation) {
        animation.onfinish = null
        animation.oncancel = null
        try {
          animation.cancel()
        } catch {
          // An optional animation implementation must not strand Vue's enter callback.
          try { animation.effect = null } catch { /* Best-effort effect release. */ }
        }
      }
      if (path) markUiFluidityForPath(path, 'settled')
      done()
    }
    const archive = archivePair(departingPath, pathname(path))
    const offset = pathname(path) === '/character' ? 16 : -16
    try {
      animation = el.animate(
        archive ? [{ opacity: 0, transform: `translateX(${offset}px)` }, { opacity: 1, transform: 'translateX(0)' }]
          : [{ transform: 'translateY(6px)' }, { transform: 'translateY(0)' }],
        { duration: archive ? 280 : 220, easing: 'cubic-bezier(.22, 1, .36, 1)' },
      )
      active.set(el, finish)
      animation.onfinish = finish
      animation.oncancel = finish
    } catch {
      // Capability detection alone does not guarantee animate() can start.
      finish()
    }
  }
  function onLeave(element: Element, done: () => void) {
    const el = element as HTMLElement
    departingPath = pathname(el.dataset.routePath || '')
    el.inert = true
    settle(el)
    if (!archivePair(departingPath, pathname(destinationPath?.() || '')) || prefersReducedMotion()
      || typeof el.animate !== 'function') { done(); return }
    let animation: Animation | undefined, finished = false
    const finish = () => {
      if (finished) return
      finished = true; active.delete(el)
      if (animation) {
        animation.onfinish = animation.oncancel = null
        try { animation.cancel() } catch { try { animation.effect = null } catch { /* Release best effort. */ } }
      }
      done()
    }
    try {
      animation = el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, easing: 'ease-out' })
      active.set(el, finish); animation.onfinish = animation.oncancel = finish
    } catch { finish() }
  }
  function onLeaveCancelled(element: Element) { settle(element as HTMLElement); (element as HTMLElement).inert = false }
  function onEnterCancelled(element: Element) { settle(element as HTMLElement) }
  function onBeforeEnter(element: Element) { (element as HTMLElement).inert = false }
  function motionChanged() { if (prefersReducedMotion()) settleAll() }
  let removeMediaListener: (() => void) | undefined
  onMounted(() => {
    // The app preference event remains available even without matchMedia.
    window.addEventListener('atelier:motion-preference', motionChanged)
    if (typeof window.matchMedia !== 'function') return
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', motionChanged)
      removeMediaListener = () => media.removeEventListener('change', motionChanged)
    } else if (typeof media.addListener === 'function') {
      media.addListener(motionChanged)
      removeMediaListener = () => media.removeListener(motionChanged)
    }
  })
  onDeactivated(settleAll)
  onUnmounted(() => {
    settleAll()
    removeMediaListener?.()
    window.removeEventListener('atelier:motion-preference', motionChanged)
  })
  return { onBeforeEnter, onEnter, onLeave, onEnterCancelled, onLeaveCancelled }
}
