import { onDeactivated, onMounted, onUnmounted } from 'vue'
import { prefersReducedMotion } from '@/utils/motionPreference'
import { markUiFluidityForPath } from '@/utils/uiFluidityMeasurement'

/** Keep content opaque and release animation effects so fixed toolbars stay viewport-bound. */
export function useRouteTransition() {
  const active = new Map<HTMLElement, () => void>()
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
    try {
      animation = el.animate(
        [{ transform: 'translateY(6px)' }, { transform: 'translateY(0)' }],
        { duration: 220, easing: 'cubic-bezier(.22, 1, .36, 1)' },
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
    // Keep the current page while loading; remove it as soon as the next one is ready.
    el.inert = true
    settle(el)
    done()
  }
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
  return { onBeforeEnter, onEnter, onLeave, onEnterCancelled }
}
