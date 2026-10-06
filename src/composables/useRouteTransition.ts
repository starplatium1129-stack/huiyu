import { onDeactivated, onMounted, onUnmounted } from 'vue'
import { listenMotionChanges, prefersReducedMotion } from '@/utils/motionPreference'
import { markUiFluidityForPath } from '@/utils/uiFluidityMeasurement'

/** Release animation effects after navigation so fixed toolbars stay viewport-bound. */
export function useRouteTransition(destinationPath?: () => string, options: { initialFade?: boolean } = {}) {
  const active = new Map<HTMLElement, () => void>()
  let interrupted = new WeakMap<HTMLElement, Keyframe>()
  const departed = new WeakSet<HTMLElement>()
  const staged = new WeakSet<HTMLElement>()
  const workspaceDeparted = new WeakSet<HTMLElement>()
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
    if (staged.has(el)) return undefined
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

  /** Stage only the existing small heading/action groups, never an image wall or canvas.
   * Querying structure needs no layout read. Existing scroll reveals keep their ownership. */
  function enterWorkspace(el: HTMLElement, done: () => void) {
    settle(el)
    el.inert = false
    const path = el.dataset.routePath || ''
    const cached = el.dataset.routeEntered === 'true'
    const returning = workspaceDeparted.delete(el)
    const samePage = cached && !returning
    el.dataset.routeEntered = 'true'
    departed.delete(el)
    if (path) markUiFluidityForPath(path, 'shell-ready')
    const heading = el.querySelector?.<HTMLElement>(
      ':scope > header, :scope > .pb-topline, :scope > .scene-atlas > .scene-atlas-copy, :scope > .home-opening .hero-copy',
    )
    const targets = !samePage && !prefersReducedMotion() && !document.hidden && heading
      ? [...heading.children].filter((child): child is HTMLElement => child instanceof HTMLElement
        && !child.closest('[data-reveal]') && !child.matches('img, canvas, video, iframe')
        && !child.querySelector('img, canvas, video, iframe')
        && !child.contains(document.activeElement) && typeof child.animate === 'function').slice(0, 2)
      : []
    const animations: Animation[] = []
    let finished = false, remaining = targets.length
    const finish = () => {
      if (finished) return
      finished = true
      active.delete(el); staged.delete(el); delete el.dataset.routeEntering
      for (const animation of animations) {
        animation.onfinish = animation.oncancel = null
        try { animation.cancel() } catch { try { animation.effect = null } catch { /* Best-effort release. */ } }
      }
      if (path) markUiFluidityForPath(path, 'settled')
      done()
    }
    if (!targets.length) { finish(); return }
    staged.add(el); active.set(el, finish)
    try {
      targets.forEach((target, index) => {
        // A cached return only settles opacity: its saved scroll/focus and canvas stay still.
        // Both groups start immediately; the second settles slightly later, without a delay.
        const frames: Keyframe[] = cached
          ? [{ opacity: .86 }, { opacity: 1 }]
          : [{ opacity: .72, transform: `translateY(${index ? 6 : 4}px)` }, { opacity: 1, transform: 'translateY(0)' }]
        const animation = target.animate(frames, { duration: cached ? 120 : 180 + index * 35, easing: 'cubic-bezier(.22, 1, .36, 1)' })
        animations.push(animation)
        animation.onfinish = () => { if (--remaining === 0) finish() }
        animation.oncancel = finish
      })
    } catch { finish() }
  }

  function onEnter(element: Element, done: () => void) {
    const el = element as HTMLElement
    const path = el.dataset.routePath || ''
    // Peer pages become interactive immediately. Only their small header groups
    // settle into place; large artwork surfaces and fixed anchors never transform.
    if (destinationPath && !archivePair(departingPath, pathname(path)) && !interrupted.has(el)) {
      enterWorkspace(el, done)
      return
    }
    workspaceDeparted.delete(el)
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
    else workspaceDeparted.add(el)
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
  let stopListening: (() => void) | undefined
  onMounted(() => {
    // Hidden tabs can suspend animation timelines; release Vue callbacks now.
    stopListening = listenMotionChanges(motionChanged, visibilityChanged)
  })
  onDeactivated(settleAll)
  onUnmounted(() => {
    settleAll()
    stopListening?.()
  })
  return { onBeforeEnter, onEnter, onLeave, onEnterCancelled, onLeaveCancelled }
}
