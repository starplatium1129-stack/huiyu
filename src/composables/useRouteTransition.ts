import { onDeactivated, onMounted, onUnmounted } from 'vue'
import { prefersReducedMotion } from '@/utils/motionPreference'
import { markUiFluidityForPath } from '@/utils/uiFluidityMeasurement'

/**
 * Workspace order provides a small directional cue, not a full-screen mobile slide.
 * Unknown routes stay neutral rather than inventing a forward/back relationship.
 */
const ROUTE_ORDER: Record<string, number> = {
  '/': 0,
  '/showcase': 1,
  '/popular-scenes': 2,
  '/scene-explorer': 3,
  '/prompt-builder': 4,
  '/chat': 5,
  '/gallery': 6,
  '/video-studio': 7,
  '/character': 8,
  '/style': 9,
  '/scenario': 10,
  '/color-script': 11,
  '/lora': 12,
  '/scene-manager': 13,
  '/control': 14,
}

function getRouteDirection(from: string, to: string): number {
  const fromIdx = ROUTE_ORDER[from]
  const toIdx = ROUTE_ORDER[to]
  if (fromIdx !== undefined && toIdx !== undefined) {
    return toIdx >= fromIdx ? 1 : -1
  }
  return 0
}

/** Release animation effects after navigation so fixed toolbars stay viewport-bound. */
export function useRouteTransition(destinationPath?: () => string, options: { initialFade?: boolean } = {}) {
  const active = new Map<HTMLElement, () => void>()
  let leaving: HTMLElement | undefined
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
    const crossRoute = !!departingPath && departingPath !== pathname(path)
    // A same-page/query refresh does not replay motion. Returning to a cached page
    // gets only a short opacity settle: no remount, translation or scroll reset.
    if ((cachedActivation && !crossRoute) || prefersReducedMotion() || typeof el.animate !== 'function') {
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
    let frames: Keyframe[] = [{ transform: 'translateY(6px)' }, { transform: 'translateY(0)' }]
    let duration = 220
    let easing = 'cubic-bezier(.22, 1, .36, 1)'

    if (crossRoute) {
      const slideOffset = getRouteDirection(departingPath, pathname(path)) * 18
      // A restrained depth hand-off: no blur animation, overshoot, layout work or
      // persistent fill. Cancel at settlement so fixed descendants regain their viewport.
      frames = [
        { opacity: 0, transform: `translateX(${slideOffset}px) scale(.992)` },
        { opacity: 1, transform: 'translateX(0) scale(1)' },
      ]
      duration = 320
      easing = 'cubic-bezier(.16, 1, .3, 1)'
    } else if (options.initialFade) {
      frames = [{ opacity: 0 }, { opacity: 1 }]
    }
    if (archive) {
      frames = [{ opacity: 0, transform: `translateX(${offset}px)` }, { opacity: 1, transform: 'translateX(0)' }]
      duration = 280
      easing = 'cubic-bezier(.22, 1, .36, 1)'
    }
    if (cachedActivation) {
      frames = [{ opacity: .88 }, { opacity: 1 }]
      duration = 150
      easing = 'cubic-bezier(.22, 1, .36, 1)'
    }
    try {
      animation = el.animate(frames, { duration, easing })
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
    // Fast navigation must not accumulate several full-page compositing layers.
    if (leaving && leaving !== el) settle(leaving)
    departingPath = pathname(el.dataset.routePath || '')
    el.inert = true
    settle(el)
    const destination = pathname(destinationPath?.() || '')
    if (!destination || destination === departingPath || prefersReducedMotion()
      || typeof el.animate !== 'function') { done(); return }
    let animation: Animation | undefined, finished = false
    const finish = () => {
      if (finished) return
      finished = true; active.delete(el)
      if (leaving === el) leaving = undefined
      if (animation) {
        animation.onfinish = animation.oncancel = null
        try { animation.cancel() } catch { try { animation.effect = null } catch { /* Release best effort. */ } }
      }
      done()
    }
    const isArchive = archivePair(departingPath, destination)
    const dir = getRouteDirection(departingPath, destination)
    const leaveOffset = dir * -8
    const leaveFrames: Keyframe[] = isArchive
      ? [{ opacity: 1 }, { opacity: 0 }]
      : [
        { opacity: 1, transform: 'translateX(0) scale(1)' },
        { opacity: 0, transform: `translateX(${leaveOffset}px) scale(.996)` },
      ]
    const leaveDuration = isArchive ? 140 : 160
    const leaveEasing = isArchive ? 'ease-out' : 'cubic-bezier(.4, 0, 1, 1)'
    try {
      animation = el.animate(leaveFrames, {
        duration: leaveDuration, easing: leaveEasing,
      })
      leaving = el; active.set(el, finish); animation.onfinish = animation.oncancel = finish
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
