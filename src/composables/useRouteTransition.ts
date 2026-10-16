import { onActivated, onDeactivated, onMounted, onUnmounted } from 'vue'
import { listenMotionChanges, prefersReducedMotion } from '@/utils/motionPreference'
import { markUiFluidityForPath } from '@/utils/uiFluidityMeasurement'
import { cssTimeToMilliseconds } from '@/utils/motionTiming'

/** Release animation effects after navigation so fixed toolbars stay viewport-bound. */
export function useRouteTransition(destinationPath?: () => string, options: { initialFade?: boolean } = {}) {
  const active = new Map<HTMLElement, () => void>()
  let keyboard = false
  let interrupted = new WeakMap<HTMLElement, Keyframe>()
  const departed = new WeakSet<HTMLElement>()
  let leaving: HTMLElement | undefined
  let departingPath = ''
  const pathname = (path: string) => path.split(/[?#]/, 1)[0]
  const archivePair = (from: string, to: string) => (from === '/popular-scenes' && to === '/character')
    || (from === '/character' && to === '/popular-scenes')
  function timing(el: HTMLElement, token: string) {
    const style = getComputedStyle(el), value = style.getPropertyValue(token).trim()
    return { duration: cssTimeToMilliseconds(value), easing: style.getPropertyValue('--ease-out').trim() }
  }
  function arriveContent(el: HTMLElement, motion: KeyframeAnimationOptions) {
    // Only marked reading surfaces move; fixed navigation and native overlays stay anchored.
    // Finish visibility reads before creating transforms; alternating the two
    // would invalidate style again for every following reading surface.
    const surfaces = [...el.querySelectorAll<HTMLElement>('[data-route-arrive]')].slice(0, 6).filter(surface => {
      // A nested surface or an image-ready reveal already has an animation owner.
      if (surface.parentElement?.closest('[data-route-arrive]') || surface.hasAttribute('data-reveal')) return false
      const rect = surface.getBoundingClientRect()
      return rect.width && rect.height && rect.bottom > 0 && rect.top < innerHeight
    })
    // Inspira UI BlurReveal's grouped arrival, without blur or per-child wrappers.
    // Adapted from 04c57ab62b9713872ebbf68988dff1836ed3d764; MIT: assets/licenses/inspira-ui.txt.
    const duration = timing(el, '--motion-route').duration
    return surfaces.map((surface, index) => surface.animate([
      { opacity: .6, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' },
    ], { ...motion, duration, delay: Math.min(index * duration / 10, duration / 4), fill: 'backwards' }))
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
    el.dataset.routeEntered = 'true'
    departed.delete(el)
    if (path) markUiFluidityForPath(path, 'shell-ready')
    let animation: Animation | undefined, finished = false
    let content: Animation[] = []
    const releaseContent = () => {
      for (const effect of content) effect.cancel()
      content = []
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
    // Cached workspaces keep their reading and scroll state. Only their shared
    // surface fades back in; the first-visit content choreography stays finished.
    if (keyboard || prefersReducedMotion() || document.hidden || typeof el.animate !== 'function') { finish(); return }
    active.set(el, finish)
    try {
      const motion = timing(el, cached ? '--motion-surface' : '--motion-route-cut')
      if (!cached) content = arriveContent(el, motion)
      animation = el.animate([{ opacity: cached ? .6 : 0 }, { opacity: 1 }], motion)
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
    if ((!current && (restored || (cachedActivation && !crossRoute))) || keyboard || prefersReducedMotion() || document.hidden || typeof el.animate !== 'function') {
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
    let durationToken = '--motion-hover'

    if (crossRoute) {
      // Peer workspaces have no forward/back hierarchy. Keep their geometry
      // still; only the real directory/detail pair below gets a spatial cue.
      frames = [{ opacity: 0 }, { opacity: 1 }]
    } else if (options.initialFade) {
      frames = [{ opacity: 0 }, { opacity: 1 }]
    }
    if (archive) {
      frames = [{ opacity: 0, transform: `translateX(${offset}px)` }, { opacity: 1, transform: 'translateX(0)' }]
      durationToken = '--motion-control'
    }
    if (cachedActivation) {
      frames = [{ opacity: .88 }, { opacity: 1 }]
      durationToken = '--motion-press'
    }
    if (current) {
      frames = [current, { opacity: 1, ...(current.transform ? { transform: 'none' } : {}) }]
      durationToken = '--motion-press'
    }
    try {
      animation = el.animate(frames, timing(el, durationToken))
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
    const current = presentation(el)
    interrupted.delete(el)
    el.inert = true
    settle(el)
    if (!destination || destination === departingPath || keyboard || prefersReducedMotion() || document.hidden
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
    try {
      animation = el.animate(leaveFrames, timing(el, isArchive ? '--motion-press' : '--motion-hover'))
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
    interrupted.delete(el); departed.delete(el)
    el.inert = false
    delete el.dataset.routeEntering
    done()
  }
  function motionChanged() { if (prefersReducedMotion()) settleAll() }
  function visibilityChanged() { if (document.hidden) settleAll() }
  function takeOver(event: Event) {
    keyboard = event.type === 'keydown'
    if (keyboard) { settleAll(); return }
    if (!(event.target instanceof Node)) return
    // The chosen panel owns the next frame, including full text opacity.
    for (const el of [...active.keys()]) {
      if (!el.inert && el.dataset.routeEntering === 'true' && el.contains(event.target)) {
        settle(el)
      }
    }
  }
  let stopListening: (() => void) | undefined
  function startListening() {
    if (stopListening) return
    // Hidden tabs can suspend animation timelines; release Vue callbacks now.
    stopListening = listenMotionChanges(motionChanged, visibilityChanged)
    document.addEventListener('pointerdown', takeOver, true)
    document.addEventListener('keydown', takeOver, true)
  }
  function stop() {
    settleAll()
    stopListening?.(); stopListening = undefined
    document.removeEventListener('pointerdown', takeOver, true)
    document.removeEventListener('keydown', takeOver, true)
  }
  onMounted(startListening)
  onActivated(startListening)
  onDeactivated(stop)
  onUnmounted(stop)
  return { onBeforeEnter, onEnter, onLeave, onEnterCancelled, onLeaveCancelled, completeEnter }
}
