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
    if (prefersReducedMotion() || typeof el.animate !== 'function') {
      if (path) markUiFluidityForPath(path, 'settled')
      done()
      return
    }
    const animation = el.animate(
      [{ transform: 'translateY(6px)' }, { transform: 'translateY(0)' }],
      { duration: 220, easing: 'cubic-bezier(.22, 1, .36, 1)' },
    )
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      active.delete(el)
      animation.onfinish = null
      animation.oncancel = null
      animation.cancel()
      if (path) markUiFluidityForPath(path, 'settled')
      done()
    }
    active.set(el, finish)
    animation.onfinish = finish
    animation.oncancel = finish
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
  let media: MediaQueryList | undefined
  onMounted(() => {
    media = matchMedia('(prefers-reduced-motion: reduce)')
    media.addEventListener('change', motionChanged)
    window.addEventListener('atelier:motion-preference', motionChanged)
  })
  onDeactivated(settleAll)
  onUnmounted(() => {
    settleAll()
    media?.removeEventListener('change', motionChanged)
    window.removeEventListener('atelier:motion-preference', motionChanged)
  })
  return { onBeforeEnter, onEnter, onLeave, onEnterCancelled }
}
