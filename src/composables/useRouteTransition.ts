import { onDeactivated, onMounted, onUnmounted } from 'vue'
import { prefersReducedMotion } from '@/utils/motionPreference'
import { markUiFluidityForPath } from '@/utils/uiFluidityMeasurement'

/** Release animation effects after navigation so fixed toolbars stay viewport-bound. */
export function useRouteTransition(destinationPath?: () => string, options: { initialFade?: boolean } = {}) {
  const active = new Map<HTMLElement, () => void>()
  let interrupted = new WeakMap<HTMLElement, Keyframe>()
  const departed = new WeakSet<HTMLElement>()
  let leaving: HTMLElement | undefined
  let departingPath = ''
  const pathname = (path: string) => path.split(/[?#]/, 1)[0]
  const archivePair = (from: string, to: string) => (from === '/popular-scenes' && to === '/character')
    || (from === '/character' && to === '/popular-scenes')
  function settle(el: HTMLElement) { active.get(el)?.() }
  function settleAll() {
    for (const finish of [...active.values()]) finish()
    interrupted = new WeakMap()
  }
  function presentation(el: HTMLElement): Keyframe | undefined {
    if (interrupted.has(el)) return interrupted.get(el)
    if (!active.has(el)) return undefined
    try {
      const style = getComputedStyle(el)
      const opacity = Number.parseFloat(style.opacity)
      if (!Number.isFinite(opacity)) return undefined
      return { opacity, ...(style.transform && style.transform !== 'none' ? { transform: style.transform } : {}) }
    } catch { return undefined }
  }
  function interrupt(el: HTMLElement) {
    // Vue cancels enter before calling leave (and vice versa). Capture before
    // cancelling WAAPI, otherwise its underlying opacity jumps back to one.
    const frame = presentation(el)
    settle(el)
    if (frame) interrupted.set(el, frame)
  }

  function onEnter(element: Element, done: () => void) {
    const el = element as HTMLElement
    const path = el.dataset.routePath || ''
    // Peer workspaces already have navigation feedback. Present their content
    // immediately instead of compositing an entire image wall for another fade.
    if (destinationPath && !archivePair(departingPath, pathname(path)) && !interrupted.has(el)) {
      settle(el)
      el.inert = false
      el.dataset.routeEntered = 'true'
      delete el.dataset.routeEntering
      departed.delete(el)
      if (path) { markUiFluidityForPath(path, 'shell-ready'); markUiFluidityForPath(path, 'settled') }
      done()
      return
    }
    const current = presentation(el)
    interrupted.delete(el)
    settle(el)
    el.inert = false
    if (path) markUiFluidityForPath(path, 'shell-ready')
    const cachedActivation = el.dataset.routeEntered === 'true'
    el.dataset.routeEntered = 'true'
    const restored = departed.delete(el)
    const crossRoute = !!departingPath && departingPath !== pathname(path)
    // A same-page/query refresh does not replay motion. Returning to a cached page
    // gets only a short opacity settle: no remount, translation or scroll reset.
    if ((!current && (restored || (cachedActivation && !crossRoute))) || prefersReducedMotion() || document.hidden || typeof el.animate !== 'function') {
      delete el.dataset.routeEntering
      if (path) markUiFluidityForPath(path, 'settled')
      done()
      return
    }
    let animation: Animation | undefined
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      delete el.dataset.routeEntering
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
    const offset = pathname(path) === '/character' ? 8 : -8
    let frames: Keyframe[] = [{ transform: 'translateY(6px)' }, { transform: 'translateY(0)' }]
    let duration = 180
    let easing = 'cubic-bezier(.22, 1, .36, 1)'

    if (crossRoute) {
      // Peer workspaces have no forward/back hierarchy. Keep their geometry
      // still; only the real directory/detail pair below gets a spatial cue.
      frames = [{ opacity: .96 }, { opacity: 1 }]
      duration = 180
    } else if (options.initialFade) {
      frames = [{ opacity: .96 }, { opacity: 1 }]
    }
    if (archive) {
      frames = [{ opacity: 0, transform: `translateX(${offset}px)` }, { opacity: 1, transform: 'translateX(0)' }]
      duration = 200
      easing = 'cubic-bezier(.22, 1, .36, 1)'
    }
    if (cachedActivation) {
      frames = [{ opacity: .88 }, { opacity: 1 }]
      duration = 120
      easing = 'cubic-bezier(.22, 1, .36, 1)'
    }
    if (current) {
      frames = [current, { opacity: 1, ...(current.transform ? { transform: 'none' } : {}) }]
      duration = 120
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
    if (!destinationPath) departed.add(el)
    // Fast navigation must not accumulate several full-page compositing layers.
    if (leaving && leaving !== el) settle(leaving)
    departingPath = pathname(el.dataset.routePath || '')
    const destination = pathname(destinationPath?.() || '')
    if (destinationPath && !archivePair(departingPath, destination)) {
      interrupted.delete(el)
      el.inert = true
      settle(el)
      done()
      return
    }
    const current = presentation(el)
    interrupted.delete(el)
    el.inert = true
    settle(el)
    if (!destination || destination === departingPath || prefersReducedMotion() || document.hidden
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
    const leaveFrames: Keyframe[] = [
      current || { opacity: 1 },
      { opacity: 0, ...(current?.transform ? { transform: current.transform } : {}) },
    ]
    const leaveDuration = isArchive ? 100 : 140
    const leaveEasing = isArchive ? 'ease-out' : 'cubic-bezier(.22, 1, .36, 1)'
    try {
      animation = el.animate(leaveFrames, {
        duration: leaveDuration, easing: leaveEasing,
      })
      leaving = el; active.set(el, finish); animation.onfinish = animation.oncancel = finish
    } catch { finish() }
  }
  function onLeaveCancelled(element: Element) { interrupt(element as HTMLElement); (element as HTMLElement).inert = false }
  function onEnterCancelled(element: Element) { interrupt(element as HTMLElement) }
  function onBeforeEnter(element: Element) {
    const el = element as HTMLElement
    el.inert = false
    el.dataset.routeEntering = 'true'
  }
  function motionChanged() { if (prefersReducedMotion()) settleAll() }
  function visibilityChanged() { if (document.hidden) settleAll() }
  let removeMediaListener: (() => void) | undefined
  onMounted(() => {
    // The app preference event remains available even without matchMedia.
    window.addEventListener('atelier:motion-preference', motionChanged)
    // Hidden tabs can suspend animation timelines; release Vue callbacks now.
    document.addEventListener('visibilitychange', visibilityChanged)
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
    document.removeEventListener('visibilitychange', visibilityChanged)
  })
  return { onBeforeEnter, onEnter, onLeave, onEnterCancelled, onLeaveCancelled }
}
