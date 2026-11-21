import { onActivated, onDeactivated, onMounted, onUnmounted } from 'vue'
import { listenMotionChanges, prefersReducedMotion } from '@/utils/motionPreference'
import { markUiFluidityForPath } from '@/utils/uiFluidityMeasurement'
import { FluidSpring } from '@/utils/fluidSpring'
import type { SpringPresentation } from '@/utils/contentSpring'
import { ROUTE_SPRING } from '@/utils/controlSprings'

type RouteDirection = -1 | 0 | 1
type TrackHandle = {
  capture: () => SpringPresentation
  cancel: () => void
}
type ReadingSurface = { motion: TrackHandle; base: string }
type Presentation = {
  root: SpringPresentation
  content: Map<HTMLElement, { state: SpringPresentation; base: string }>
}
type Arrival = {
  root: TrackHandle
  content: Map<HTMLElement, ReadingSurface>
  finish: () => void
}

/** Matches AppNav primary navigation order first, followed by secondary workspace entries. */
const ROUTE_ORDER = new Map<string, number>([
  ['/', 0],
  ['/prompt-builder', 1],
  ['/character', 2],
  ['/scene-explorer', 3],
  ['/showcase', 4],
  ['/gallery', 5],
  ['/chat', 6],
  ['/video-studio', 7],
  ['/scenario', 8],
  ['/color-script', 9],
  ['/popular-scenes', 10],
  ['/style', 11],
  ['/lora', 12],
  ['/scene-manager', 13],
  ['/control', 14],
  ['/guide', 15],
])
const PRIMARY_MAX_INDEX = 6
const STORYBOARD_MAX_SURFACES = 4
const STORYBOARD_STAGGER_MS = [0, 30, 60, 60] as const
const STORYBOARD_OFFSET_X = 14
const STORYBOARD_OFFSET_Y = 8
const LEAVE_DURATION_MS = 160
const REDUCED_ENTER_DURATION_MS = 100
const EASE_OUT_CSS = 'cubic-bezier(0.23, 1, 0.32, 1)'

function resolveDirection(fromPath: string, toPath: string): RouteDirection {
  if (!fromPath || !toPath || fromPath === toPath) return 0
  const fromIndex = ROUTE_ORDER.get(fromPath)
  const toIndex = ROUTE_ORDER.get(toPath)
  if (fromIndex !== undefined && toIndex !== undefined) {
    if (fromIndex === toIndex) return 0
    return toIndex > fromIndex ? 1 : -1
  }
  if (toPath === '/') return -1
  if (fromPath === '/') return 1
  if (fromIndex !== undefined && fromIndex <= PRIMARY_MAX_INDEX && toIndex === undefined) return 1
  if (toIndex !== undefined && toIndex <= PRIMARY_MAX_INDEX && fromIndex === undefined) return -1
  return 0
}

/** Compositor-only WAAPI opacity fade for leaving routes and reduced-motion arrivals. */
function runOpacityFade(
  element: HTMLElement,
  from: number,
  to: number,
  duration: number,
  complete?: () => void,
): TrackHandle {
  const start = Math.max(0, Math.min(1, from))
  const end = Math.max(0, Math.min(1, to))
  let effect: Animation | undefined
  let cancelled = false
  const capture = (): SpringPresentation => {
    if (effect) {
      const computed = Number.parseFloat(getComputedStyle(element).opacity)
      if (Number.isFinite(computed)) return { values: [Math.max(0, Math.min(1, computed))], velocities: [0] }
    }
    return { values: [start], velocities: [0] }
  }
  const cancel = () => {
    cancelled = true
    effect?.cancel()
    effect = undefined
  }
  if (document.hidden || typeof element.animate !== 'function' || duration <= 0) {
    complete?.()
    return { capture, cancel }
  }
  try {
    effect = element.animate([{ opacity: start }, { opacity: end }], { duration, easing: EASE_OUT_CSS, fill: 'both' })
    void effect.finished.then(
      () => { if (!cancelled) { effect = undefined; complete?.() } },
      () => { if (!cancelled) { effect = undefined; complete?.() } },
    )
  } catch {
    complete?.()
  }
  return { capture, cancel }
}

/** Sample a critically damped spring into compositor WAAPI keyframes with optional stagger delay. */
function runStaggeredSpring(
  element: HTMLElement,
  initial: number[],
  targets: number[],
  frame: (values: number[]) => Keyframe,
  options: { velocities?: number[]; opacity?: number; delay?: number; frequency?: number; damping?: number } = {},
  complete?: () => void,
): TrackHandle {
  const delay = Math.max(0, options.delay ?? 0)
  const springs = initial.map((value, index) => {
    const isOpacity = index === options.opacity
    const spring = new FluidSpring(
      value,
      options.frequency ?? (isOpacity ? 7.2 : ROUTE_SPRING.frequency),
      options.damping ?? (isOpacity ? 1 : ROUTE_SPRING.damping),
    )
    spring.velocity = options.velocities?.[index] ?? 0
    spring.to(targets[index])
    return spring
  })
  const origin: SpringPresentation = {
    values: springs.map(s => s.value),
    velocities: springs.map(s => s.velocity),
  }
  const copies = springs.map(spring => {
    const copy = new FluidSpring(spring.value, spring.frequency, spring.damping)
    copy.velocity = spring.velocity
    copy.to(spring.target)
    return copy
  })
  const samples: number[][] = [origin.values]
  for (let i = 0; i < 90 && copies.some(s => !s.settled); i++) {
    samples.push(copies.map(s => s.step(1 / 60)))
  }
  let effect: Animation | undefined
  let cancelled = false
  const capture = (): SpringPresentation => {
    if (!effect) return origin
    const elapsedMs = Math.max(0, (Number(effect.currentTime) || 0) - delay)
    const seconds = elapsedMs / 1000
    const cursor = Math.min(seconds * 60, samples.length - 1)
    const index = Math.floor(cursor)
    const values = springs.map((spring, channel) => {
      spring.value = origin.values[channel]
      spring.velocity = origin.velocities[channel]
      spring.step(seconds)
      const lo = samples[index][channel]
      const hi = samples[index + 1]?.[channel] ?? lo
      const interpolated = lo + (hi - lo) * (cursor - index)
      return channel === options.opacity ? Math.max(0, Math.min(1, interpolated)) : interpolated
    })
    return { values, velocities: springs.map(s => s.velocity) }
  }
  const cancel = () => {
    cancelled = true
    effect?.cancel()
    effect = undefined
  }
  if (document.hidden || typeof element.animate !== 'function') {
    complete?.()
    return { capture, cancel }
  }
  try {
    const frames = samples.map(frame)
    effect = element.animate(frames, {
      duration: Math.max(1, (frames.length - 1) * 1000 / 60),
      delay,
      fill: 'both',
      easing: 'linear',
    })
    void effect.finished.then(
      () => { if (!cancelled) { effect = undefined; complete?.() } },
      () => { if (!cancelled) { effect = undefined; complete?.() } },
    )
  } catch {
    complete?.()
  }
  return { capture, cancel }
}

/**
 * Direction-aware "artbook storyboard" route transition:
 * - Leaving route fades purely in opacity (160ms ease-out) so fixed chrome/popovers never shift.
 * - Entering route glides up to 4 [data-route-arrive] blocks (±14px, 8px -> none, stagger 0/30/60ms).
 * - Always interruptible from current live pose; focus & interactivity commit immediately.
 * - Reduced motion degrades to instant leave + 100ms pure opacity fade-in.
 */
export function useRouteTransition(destinationPath: () => string) {
  const active = new Map<HTMLElement, Arrival>()
  const pending = new Map<HTMLElement, { observer: ResizeObserver; finish: () => void }>()
  let keyboard = false
  let interrupted = new WeakMap<HTMLElement, Presentation>()
  let departure: { path: string; time: number; root: SpringPresentation; content: SpringPresentation[] } | undefined
  let leaving: HTMLElement | undefined
  let lastEnteredPath = ''
  let pendingDirection: { to: string; dir: RouteDirection; time: number } | undefined
  let focusReturn: { href: string | null; origin: Element } | undefined
  const pathname = (path: string) => path.split(/[?#]/, 1)[0]

  function settle(el: HTMLElement) { pending.get(el)?.finish(); active.get(el)?.finish() }
  function settleAll() {
    for (const arrival of [...pending.values()]) arrival.finish()
    for (const arrival of [...active.values()]) arrival.finish()
    interrupted = new WeakMap()
    departure = undefined
  }
  function presentation(el: HTMLElement): Presentation | undefined {
    const saved = interrupted.get(el)
    if (saved) return saved
    const arrival = active.get(el)
    if (!arrival) return
    return {
      root: arrival.root.capture(),
      content: new Map([...arrival.content].map(([surface, { motion, base }]) => [surface, { state: motion.capture(), base }])),
    }
  }
  function interrupt(el: HTMLElement) {
    // Vue cancels enter before leave. Read the live timeline before releasing it.
    const current = presentation(el)
    settle(el)
    if (current) interrupted.set(el, current)
  }
  function restoreFocus(el: HTMLElement) {
    const ticket = focusReturn; focusReturn = undefined
    if (!keyboard || !ticket) return
    const current = document.activeElement
    if (current && current !== document.body && current !== ticket.origin) return
    const link = [...el.querySelectorAll<HTMLAnchorElement>('a[href]')].find(anchor => anchor.href === ticket.href
      && !anchor.closest('[inert], [hidden]') && anchor.getClientRects().length)
    const main = el.closest<HTMLElement>('main') || el.querySelector<HTMLElement>('main')
    ;(link || main)?.focus({ preventScroll: true })
  }
  function readingSurfaces(el: HTMLElement) {
    // Cap animated storyboard panels to 4 visible primary blocks for crisp cadence & low compositor load.
    return [...el.querySelectorAll<HTMLElement>('[data-route-arrive]')].filter(surface => {
      if (surface.parentElement?.closest('[data-route-arrive]') || surface.hasAttribute('data-reveal')) return false
      const rect = surface.getBoundingClientRect()
      return rect.width && rect.height && rect.bottom > 0 && rect.top < innerHeight
    }).slice(0, STORYBOARD_MAX_SURFACES).map(surface => {
      const transform = getComputedStyle(surface).transform
      return { surface, base: transform === 'none' ? '' : ` ${transform}` }
    })
  }
  function resolveEnterDirection(toPath: string): RouteDirection {
    if (pendingDirection && pendingDirection.to === toPath && performance.now() - pendingDirection.time < 600) {
      const dir = pendingDirection.dir
      pendingDirection = undefined
      return dir
    }
    return resolveDirection(lastEnteredPath, toPath)
  }
  function transition(el: HTMLElement, entering: boolean, done: () => void) {
    const path = el.dataset.routePath || ''
    const cleanPath = pathname(path)
    let current = presentation(el)
    // Non-cached routes can remount while their old keyed leave is cancelled.
    // Hand that presentation to the replacement only in the same navigation turn.
    if (!current && entering && departure?.path === cleanPath && performance.now() - departure.time < 120) {
      const states = departure.content
      current = {
        root: departure.root,
        content: new Map(readingSurfaces(el).flatMap(({ surface, base }, index) =>
          states[index] ? [[surface, { base, state: states[index] }] as const] : [])),
      }
      departure = undefined
    }
    interrupted.delete(el)
    settle(el)
    if (entering) {
      el.inert = false
      restoreFocus(el)
      el.dataset.routeEntered = 'true'
      if (path) markUiFluidityForPath(path, 'shell-ready')
    } else {
      el.inert = true
    }

    const reduced = prefersReducedMotion()
    if (document.hidden || typeof el.animate !== 'function') {
      if (entering && cleanPath) lastEnteredPath = cleanPath
      delete el.dataset.routeEntering
      delete el.dataset.routeDirection
      if (entering && path) markUiFluidityForPath(path, 'settled')
      done()
      return
    }
    if (reduced) {
      if (!entering) {
        delete el.dataset.routeEntering
        delete el.dataset.routeDirection
        done()
        return
      }
      if (cleanPath) lastEnteredPath = cleanPath
      const startOpacity = current?.root.values[0] ?? 0.15
      let finished = false
      let root: TrackHandle | undefined
      const content = new Map<HTMLElement, ReadingSurface>()
      const finish = () => {
        if (finished) return
        finished = true
        active.delete(el)
        delete el.dataset.routeEntering
        delete el.dataset.routeDirection
        root?.cancel()
        if (path) markUiFluidityForPath(path, 'settled')
        done()
      }
      root = runOpacityFade(el, startOpacity, 1, REDUCED_ENTER_DURATION_MS, finish)
      if (!finished) active.set(el, { root, content, finish })
      return
    }

    if (!entering) {
      const startOpacity = current?.root.values[0] ?? 1
      const duration = Math.max(40, Math.round(LEAVE_DURATION_MS * startOpacity))
      let finished = false
      let root: TrackHandle | undefined
      const content = new Map<HTMLElement, ReadingSurface>()
      const finish = () => {
        if (finished) return
        const state = presentation(el)
        if (state && state.root.values[0] > 0) {
          departure = {
            path: cleanPath,
            time: performance.now(),
            root: state.root,
            content: [...state.content.values()].map(value => value.state),
          }
        }
        finished = true
        active.delete(el)
        delete el.dataset.routeEntering
        delete el.dataset.routeDirection
        if (leaving === el) leaving = undefined
        root?.cancel()
        done()
      }
      root = runOpacityFade(el, startOpacity, 0, duration, finish)
      if (!finished) {
        active.set(el, { root, content, finish })
        leaving = el
      }
      return
    }

    const direction = resolveEnterDirection(cleanPath)
    if (cleanPath) lastEnteredPath = cleanPath
    el.dataset.routeDirection = direction > 0 ? 'forward' : direction < 0 ? 'backward' : 'neutral'

    const content = new Map<HTMLElement, ReadingSurface>()
    const surfaces = current
      ? [...current.content].map(([surface, value]) => ({ surface, base: value.base, state: value.state, delay: 0 }))
      : readingSurfaces(el).map((value, index) => ({
          ...value,
          state: { values: [direction * STORYBOARD_OFFSET_X, STORYBOARD_OFFSET_Y, 0.25], velocities: [0, 0, 0] },
          delay: STORYBOARD_STAGGER_MS[index] ?? 60,
        }))

    let finished = false
    let remaining = surfaces.length + 1
    let root: TrackHandle | undefined
    const arrived = () => { if (--remaining <= 0) finish() }
    const finish = () => {
      if (finished) return
      finished = true
      active.delete(el)
      delete el.dataset.routeEntering
      delete el.dataset.routeDirection
      root?.cancel()
      for (const surface of content.values()) surface.motion.cancel()
      if (path) markUiFluidityForPath(path, 'settled')
      done()
    }

    for (const { surface, base, state, delay } of surfaces) {
      const startX = state.values[0] ?? 0
      const startY = state.values[1] ?? 0
      const startOpacity = state.values[2] ?? 1
      const motion = runStaggeredSpring(
        surface,
        [startX, startY, startOpacity],
        [0, 0, 1],
        ([x, y, opacity]) => ({ transform: `translate3d(${x}px, ${y}px, 0)${base}`, opacity }),
        { velocities: state.velocities, opacity: 2, delay, frequency: ROUTE_SPRING.frequency, damping: ROUTE_SPRING.damping },
        arrived,
      )
      content.set(surface, { base, motion })
    }

    const rootStart = current?.root ?? { values: [0.15], velocities: [0] }
    root = runStaggeredSpring(
      el,
      rootStart.values,
      [1],
      ([opacity]) => ({ opacity }),
      { velocities: rootStart.velocities, opacity: 0, frequency: ROUTE_SPRING.frequency, damping: ROUTE_SPRING.damping },
      arrived,
    )
    if (!finished) active.set(el, { root, content, finish })
  }

  function onEnter(element: Element, done: () => void) {
    const el = element as HTMLElement
    if (prefersReducedMotion() || document.hidden
      || typeof ResizeObserver === 'undefined' || !el.querySelector('[data-route-arrive]')) {
      transition(el, true, done)
      return
    }
    // Both first and cached arrivals measure reading surfaces. Observe the browser's
    // natural layout before measuring, then start the animation before paint;
    // entering must not synchronously lay out a route inside Vue's patch.
    const observer = new ResizeObserver(() => {
      if (!pending.has(el)) return
      observer.disconnect(); pending.delete(el)
      transition(el, true, done)
    })
    pending.set(el, {
      observer,
      finish: () => {
        observer.disconnect(); pending.delete(el)
        delete el.dataset.routeEntering
        delete el.dataset.routeDirection
        done()
      },
    })
    observer.observe(el)
  }
  function onLeave(element: Element, done: () => void) {
    const el = element as HTMLElement, origin = document.activeElement
    focusReturn = keyboard && origin && el.contains(origin)
      ? { href: origin.closest<HTMLAnchorElement>('a[href]')?.href ?? null, origin } : undefined
    // Keep at most one departing full-page layer during fast navigation.
    if (leaving && leaving !== el) settle(leaving)
    const fromPath = pathname(el.dataset.routePath || '')
    const destination = pathname(destinationPath())
    if (fromPath && destination && fromPath !== destination) {
      pendingDirection = { to: destination, dir: resolveDirection(fromPath, destination), time: performance.now() }
    }
    if (!destination || destination === fromPath) { settle(el); el.inert = true; done(); return }
    transition(el, false, done)
  }
  function onLeaveCancelled(element: Element) {
    interrupt(element as HTMLElement); (element as HTMLElement).inert = false
    if (focusReturn && element.contains(focusReturn.origin)) focusReturn = undefined
  }
  function onEnterCancelled(element: Element) { interrupt(element as HTMLElement) }
  function onBeforeEnter(element: Element) {
    const el = element as HTMLElement
    el.inert = false; el.dataset.routeEntering = 'true'
  }
  function completeEnter(element: Element, done: () => void) {
    const el = element as HTMLElement
    const cleanPath = pathname(el.dataset.routePath || destinationPath())
    if (cleanPath) lastEnteredPath = cleanPath
    settle(el); interrupted.delete(el); el.inert = false
    delete el.dataset.routeEntering; delete el.dataset.routeDirection
    restoreFocus(el); done()
  }
  function preference() { if (document.hidden || prefersReducedMotion()) settleAll() }
  function input(event: Event) {
    keyboard = event.type === 'keydown'
    // A chosen panel may animate immediately without snapping the route's tail.
    if (event.target instanceof Node) for (const el of active.keys()) {
      if (!el.inert && el.contains(event.target)) delete el.dataset.routeEntering
    }
  }
  let stopListening: (() => void) | undefined
  function startListening() {
    if (stopListening) return
    stopListening = listenMotionChanges(preference)
    document.addEventListener('pointerdown', input, true)
    document.addEventListener('keydown', input, true)
  }
  function stop() {
    settleAll(); focusReturn = undefined; pendingDirection = undefined
    stopListening?.(); stopListening = undefined
    document.removeEventListener('pointerdown', input, true)
    document.removeEventListener('keydown', input, true)
  }
  onMounted(startListening); onActivated(startListening)
  onDeactivated(stop); onUnmounted(stop)
  return { onBeforeEnter, onEnter, onLeave, onEnterCancelled, onLeaveCancelled, completeEnter }
}
