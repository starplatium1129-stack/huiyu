import { onActivated, onDeactivated, onMounted, onUnmounted } from 'vue'
import { listenMotionChanges, prefersReducedMotion } from '@/utils/motionPreference'
import { markUiFluidityForPath } from '@/utils/uiFluidityMeasurement'
import { createContentSpring, type ContentSpring, type SpringPresentation } from '@/utils/contentSpring'

type ReadingSurface = { motion: ContentSpring; base: string }
type Presentation = { root: SpringPresentation; content: Map<HTMLElement, { state: SpringPresentation; base: string }> }
type Arrival = { root: ContentSpring; content: Map<HTMLElement, ReadingSurface>; finish: () => void }

/** The route root only fades: fixed toolbars and native-overlay anchors stay put. */
export function useRouteTransition(destinationPath: () => string) {
  const active = new Map<HTMLElement, Arrival>()
  let keyboard = false
  let interrupted = new WeakMap<HTMLElement, Presentation>()
  let departure: { path: string; time: number; root: SpringPresentation; content: SpringPresentation[] } | undefined
  let leaving: HTMLElement | undefined
  let focusReturn: { href: string | null; origin: Element } | undefined
  const pathname = (path: string) => path.split(/[?#]/, 1)[0]
  function settle(el: HTMLElement) { active.get(el)?.finish() }
  function settleAll() {
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
    // Inspira UI grouped arrival, adapted without blur, wrappers or a stagger queue.
    // Source: 04c57ab62b9713872ebbf68988dff1836ed3d764; MIT: assets/licenses/inspira-ui.txt.
    return [...el.querySelectorAll<HTMLElement>('[data-route-arrive]')].slice(0, 6).filter(surface => {
      if (surface.parentElement?.closest('[data-route-arrive]') || surface.hasAttribute('data-reveal')) return false
      const rect = surface.getBoundingClientRect()
      return rect.width && rect.height && rect.bottom > 0 && rect.top < innerHeight
    }).map(surface => {
      const transform = getComputedStyle(surface).transform
      return { surface, base: transform === 'none' ? '' : ` ${transform}` }
    })
  }
  function transition(el: HTMLElement, entering: boolean, done: () => void) {
    const path = el.dataset.routePath || ''
    let current = presentation(el)
    // Non-cached routes can remount while their old keyed leave is cancelled.
    // Hand that presentation to the replacement only in the same navigation turn.
    if (!current && entering && departure?.path === pathname(path) && performance.now() - departure.time < 120) {
      const states = departure.content
      current = { root: departure.root, content: new Map(readingSurfaces(el).flatMap(({ surface, base }, index) =>
        states[index] ? [[surface, { base, state: states[index] }] as const] : [])) }
      departure = undefined
    }
    interrupted.delete(el); settle(el)
    const cached = el.dataset.routeEntered === 'true'
    if (entering) {
      el.inert = false; restoreFocus(el); el.dataset.routeEntered = 'true'
      if (path) markUiFluidityForPath(path, 'shell-ready')
    } else el.inert = true
    if (prefersReducedMotion() || document.hidden) {
      delete el.dataset.routeEntering
      if (entering && path) markUiFluidityForPath(path, 'settled')
      done(); return
    }
    const content = new Map<HTMLElement, ReadingSurface>()
    const surfaces = current ? [...current.content].map(([surface, value]) => ({ surface, ...value }))
      : entering && !cached ? readingSurfaces(el).map(value => ({ ...value, state: { values: [10], velocities: [0] } })) : []
    for (const { surface, base, state } of surfaces) {
      content.set(surface, { base, motion: createContentSpring(surface, state.values,
        ([y]) => ({ transform: `translateY(${y}px)${base}` }), { velocities: state.velocities }) })
    }
    const state = current?.root ?? { values: [entering ? cached ? .65 : .25 : 1], velocities: [0] }
    const root = createContentSpring(el, state.values, ([opacity]) => ({ opacity }), { velocities: state.velocities, opacity: 0 })
    let finished = false, pending = content.size + 1
    const finish = () => {
      if (finished) return
      if (!entering) {
        const state = presentation(el)
        if (state && state.root.values[0] > 0) departure = {
          path: pathname(path), time: performance.now(), root: state.root, content: [...state.content.values()].map(value => value.state),
        }
      }
      finished = true; active.delete(el); delete el.dataset.routeEntering
      if (leaving === el) leaving = undefined
      root.cancel(); for (const surface of content.values()) surface.motion.cancel()
      if (entering && path) markUiFluidityForPath(path, 'settled')
      done()
    }
    active.set(el, { root, content, finish })
    if (!entering) leaving = el
    const arrived = () => { if (--pending === 0) finish() }
    // State/focus are already current; no operation waits for the spring's tail.
    for (const surface of content.values()) surface.motion.to([0], entering ? arrived : undefined)
    root.to([entering ? 1 : 0], entering ? arrived : finish)
  }
  function onEnter(element: Element, done: () => void) { transition(element as HTMLElement, true, done) }
  function onLeave(element: Element, done: () => void) {
    const el = element as HTMLElement, origin = document.activeElement
    focusReturn = keyboard && origin && el.contains(origin)
      ? { href: origin.closest<HTMLAnchorElement>('a[href]')?.href ?? null, origin } : undefined
    // Keep at most one departing full-page layer during fast navigation.
    if (leaving && leaving !== el) settle(leaving)
    const destination = pathname(destinationPath())
    if (!destination || destination === pathname(el.dataset.routePath || '')) { settle(el); el.inert = true; done(); return }
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
    settle(el); interrupted.delete(el); el.inert = false; delete el.dataset.routeEntering
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
    settleAll(); focusReturn = undefined
    stopListening?.(); stopListening = undefined
    document.removeEventListener('pointerdown', input, true)
    document.removeEventListener('keydown', input, true)
  }
  onMounted(startListening); onActivated(startListening)
  onDeactivated(stop); onUnmounted(stop)
  return { onBeforeEnter, onEnter, onLeave, onEnterCancelled, onLeaveCancelled, completeEnter }
}
