import { onDeactivated, onMounted, onUnmounted } from 'vue'
import { listenMotionChanges, prefersReducedMotion } from '@/utils/motionPreference'
import { markUiFluidityForPath } from '@/utils/uiFluidityMeasurement'

/** Release animation effects after navigation so fixed toolbars stay viewport-bound. */
export function useRouteTransition(destinationPath?: () => string, options: { initialFade?: boolean } = {}) {
  const active = new Map<HTMLElement, () => void>()
  const contentArrivals = new WeakMap<HTMLElement, () => void>()
  let interrupted = new WeakMap<HTMLElement, Keyframe>()
  const departed = new WeakSet<HTMLElement>()
  const workspaceDeparted = new WeakSet<HTMLElement>()
  let leaving: HTMLElement | undefined
  let departingPath = ''
  const pathname = (path: string) => path.split(/[?#]/, 1)[0]
  const archivePair = (from: string, to: string) => (from === '/popular-scenes' && to === '/character')
    || (from === '/character' && to === '/popular-scenes')
  function arriveContent(el: HTMLElement, duration: number) {
    // Only marked reading surfaces move; fixed navigation and native overlays stay anchored.
    return [...el.querySelectorAll<HTMLElement>('[data-route-arrive]')].slice(0, 6).flatMap(surface => {
      const rect = surface.getBoundingClientRect()
      if (!rect.width || !rect.height || rect.bottom <= 0 || rect.top >= innerHeight) return []
      return [surface.animate([{ transform: 'translateY(16px)' }, { transform: 'none' }], {
        duration, easing: 'cubic-bezier(.22,1,.36,1)',
      })]
    })
  }
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

  /** Fade the workspace as one surface; fixed controls keep their viewport geometry. */
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
    let animation: Animation | undefined, finished = false
    let content: Animation[] = []
    const releaseContent = () => {
      for (const effect of content) effect.cancel()
      content = []
      contentArrivals.delete(el)
    }
    const finish = () => {
      if (finished) return
      finished = true
      active.delete(el); delete el.dataset.routeEntering
      releaseContent()
      if (animation) {
        animation.onfinish = animation.oncancel = null
        try { animation.cancel() } catch { try { animation.effect = null } catch { /* Best-effort release. */ } }
      }
      if (path) markUiFluidityForPath(path, 'settled')
      done()
    }
    if (samePage || prefersReducedMotion() || document.hidden || typeof el.animate !== 'function') { finish(); return }
    active.set(el, finish)
    try {
      const duration = cached ? 280 : 360
      if (!cached) content = arriveContent(el, duration)
      contentArrivals.set(el, releaseContent)
      animation = el.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration, easing: 'cubic-bezier(.22, 1, .36, 1)',
      })
      animation.onfinish = animation.oncancel = finish
    } catch { finish() }
  }

  function onEnter(element: Element, done: () => void) {
    const el = element as HTMLElement
    const path = el.dataset.routePath || ''
    // Peer pages become interactive immediately while their content fades in.
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
      frames = [{ opacity: 0 }, { opacity: 1 }]
      duration = 180
    } else if (options.initialFade) {
      frames = [{ opacity: 0 }, { opacity: 1 }]
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
    try {
      animation = el.animate(leaveFrames, {
        duration: leaveDuration, easing: 'cubic-bezier(.22, 1, .36, 1)',
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
  /** A cached AppLayout delegates entry to its inner route, but still releases its own leave state. */
  function completeEnter(element: Element, done: () => void) {
    const el = element as HTMLElement
    settle(el)
    interrupted.delete(el); departed.delete(el); workspaceDeparted.delete(el)
    el.inert = false
    delete el.dataset.routeEntering
    done()
  }
  function motionChanged() { if (prefersReducedMotion()) settleAll() }
  function visibilityChanged() { if (document.hidden) settleAll() }
  function takeOver(event: Event) {
    if (!(event.target instanceof Node)) return
    // Let the chosen panel own its next frame while the page fade continues.
    for (const el of [...active.keys()]) {
      if (!el.inert && el.dataset.routeEntering === 'true' && el.contains(event.target)) {
        contentArrivals.get(el)?.()
        delete el.dataset.routeEntering
      }
    }
  }
  let stopListening: (() => void) | undefined
  onMounted(() => {
    // Hidden tabs can suspend animation timelines; release Vue callbacks now.
    stopListening = listenMotionChanges(motionChanged, visibilityChanged)
    document.addEventListener('pointerdown', takeOver, true)
    document.addEventListener('keydown', takeOver, true)
  })
  onDeactivated(settleAll)
  onUnmounted(() => {
    settleAll()
    stopListening?.()
    document.removeEventListener('pointerdown', takeOver, true)
    document.removeEventListener('keydown', takeOver, true)
  })
  return { onBeforeEnter, onEnter, onLeave, onEnterCancelled, onLeaveCancelled, completeEnter }
}
