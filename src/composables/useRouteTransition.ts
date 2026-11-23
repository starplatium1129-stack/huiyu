import { onActivated, onDeactivated, onMounted, onScopeDispose, watch } from 'vue'
import { useRoute } from 'vue-router'
import { navigationDirection } from '@/router/navigationItems'
import { listenMotionChanges, prefersReducedMotion } from '@/utils/motionPreference'
import { cssTimeToMilliseconds } from '@/utils/motionTiming'
import { markUiFluidityForPath } from '@/utils/uiFluidityMeasurement'

const MAX_STAGGER_SURFACES = 4
const STAGGER_DELAY_MS = [0, 30, 60, 85] as const
const ENTER_OFFSET_X = 14
const ENTER_OFFSET_Y = 8
/** Critically-damped route arrival frequency (Hz): readable travel without bouncing large text. */
const ROUTE_SPRING_FREQUENCY = 3.2

let cachedRouteCurve: { samples: number[]; duration: number } | undefined

/** Sample the critically-damped arrival curve once; WAAPI plays it on the compositor. */
function routeArrivalCurve() {
  if (cachedRouteCurve) return cachedRouteCurve
  // Exact closed-form critically damped spring (damping = 1): x(t) = 1 - (1 + ωt)e^(-ωt).
  const omega = 2 * Math.PI * ROUTE_SPRING_FREQUENCY
  const samples = [0]
  for (let index = 1; index <= 48; index++) {
    const wt = omega * (index / 60)
    const value = 1 - (1 + wt) * Math.exp(-wt)
    if (value >= 0.998) break
    samples.push(value)
  }
  samples.push(1)
  cachedRouteCurve = { samples, duration: Math.max(180, (samples.length - 1) * 1000 / 60) }
  return cachedRouteCurve
}

function collectArrivalSurfaces(content: HTMLElement): HTMLElement[] {
  const candidates: HTMLElement[] = []
  for (const node of content.querySelectorAll<HTMLElement>('[data-route-arrive]')) {
    if (node.parentElement?.closest('[data-route-arrive]') || node.hasAttribute('data-reveal')
      || node.closest('[hidden], [inert]')) continue
    candidates.push(node)
    if (candidates.length === MAX_STAGGER_SURFACES) break
  }
  if (candidates.length) return candidates
  const heading = content.querySelector<HTMLElement>('h1:not(.sr-only), [data-route-arrive] h2')
  if (!heading) return []
  const intro = heading.closest<HTMLElement>('header') ?? heading.parentElement
  return [intro && intro !== content && content.contains(intro) ? intro : heading]
}

/** Release the outgoing page immediately; only the incoming content owns an animation. */
export function useRouteTransition() {
  const route = useRoute()
  let direction = 0
  watch(() => route.path, (to, from) => { direction = navigationDirection(from, to) }, { flush: 'sync' })
  let arrival: { root: HTMLElement; finish: () => void } | undefined
  let focusReturn: { origin: Element; href: string | null } | undefined
  let stopPreferences: (() => void) | undefined
  let timing: { duration: number; easing: string } | undefined
  let timingFrame = 0
  let focusFrame = 0
  let pendingFocus: Element | undefined

  function restoreFocus(root: HTMLElement) {
    const ticket = focusReturn
    focusReturn = undefined
    if (!ticket || (document.activeElement !== document.body && document.activeElement !== ticket.origin)) return
    const link = ticket.href && Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href]')).find(anchor =>
      anchor.href === ticket.href && !anchor.closest('[inert], [hidden]') && anchor.getClientRects().length > 0)
    const main = root.closest<HTMLElement>('main') ?? root.querySelector<HTMLElement>('main')
    ;(link || main)?.focus({ preventScroll: true })
  }

  function onBeforeEnter(element: Element) {
    const root = element as HTMLElement
    root.inert = false
    root.dataset.routeEntering = 'true'
  }

  function onEnter(element: Element, done: () => void) {
    const root = element as HTMLElement
    arrival?.finish()
    if (focusReturn && !pendingFocus) {
      pendingFocus = root
      focusFrame = requestAnimationFrame(() => {
        focusFrame = requestAnimationFrame(() => {
          pendingFocus = undefined
          if (root.isConnected && !root.inert) restoreFocus(root)
        })
      })
    }
    root.dataset.routeEntered = 'true'
    // The nested RouterView owns the page inside the persistent navigation shell.
    const path = root.classList.contains('page-root') ? undefined : root.dataset.routePath
    if (path) markUiFluidityForPath(path, 'shell-ready')
    const effects: Animation[] = []
    let finished = false
    function finish() {
      if (finished) return
      finished = true
      arrival = undefined
      for (const effect of effects) effect.cancel()
      root.removeEventListener('pointerdown', finish, true)
      root.removeEventListener('keydown', finish, true)
      delete root.dataset.routeEntering
      if (path) markUiFluidityForPath(path, 'settled')
      done()
    }
    // The control room has its own navigation. Companion windows anchor native
    // surfaces and do not take part in studio page turns.
    const content = root.classList.contains('control-page') ? root.querySelector<HTMLElement>('#control-main')
      : root.classList.contains('route-view') ? root : null
    if (!path || !content?.animate || document.hidden || prefersReducedMotion()) { finish(); return }

    if (!timing || !(timing.duration > 0)) { finish(); return }
    const { duration, easing } = timing
    const surfaces = collectArrivalSurfaces(content)
    // Only opacity touches the outer content so fixed tools and sticky chrome keep their viewport context.
    effects.push(content.animate(
      [{ opacity: surfaces.length ? 0.55 : 0.22 }, { opacity: 1 }],
      { duration: surfaces.length ? Math.min(duration, 220) : duration, easing },
    ))
    if (surfaces.length) {
      const { samples, duration: springDuration } = routeArrivalCurve()
      const travelDuration = Math.min(springDuration, duration + 60)
      for (let index = 0; index < surfaces.length; index++) {
        const surface = surfaces[index]!
        const startX = direction * ENTER_OFFSET_X
        const startY = ENTER_OFFSET_Y + index * 2
        const frames = samples.map(progress => ({
          opacity: Math.min(1, 0.25 + 0.75 * Math.min(1, progress * 1.4)),
          translate: `${((1 - progress) * startX).toFixed(2)}px ${((1 - progress) * startY).toFixed(2)}px`,
        }))
        effects.push(surface.animate(frames, {
          duration: travelDuration,
          delay: STAGGER_DELAY_MS[index] ?? 0,
          fill: 'both',
          easing: 'linear',
        }))
      }
    }
    arrival = { root, finish }
    root.addEventListener('pointerdown', finish, true)
    root.addEventListener('keydown', finish, true)
    void Promise.all(effects.map(effect => effect.finished)).then(finish, finish)
  }

  function onEnterCancelled(element: Element) {
    if (arrival?.root === element) arrival.finish()
  }

  function onLeave(element: Element, done: () => void) {
    const root = element as HTMLElement
    if (pendingFocus === root) {
      cancelAnimationFrame(focusFrame)
      pendingFocus = undefined
    }
    const origin = document.activeElement
    focusReturn = origin && root.contains(origin) && origin.matches(':focus-visible')
      ? { origin, href: origin.closest<HTMLAnchorElement>('a[href]')?.href ?? null } : undefined
    onEnterCancelled(root)
    root.inert = true
    done()
  }

  function readTimingAfterPaint() {
    cancelAnimationFrame(timingFrame)
    timingFrame = requestAnimationFrame(() => {
      timingFrame = requestAnimationFrame(() => {
        const tokens = getComputedStyle(document.documentElement)
        timing = {
          duration: cssTimeToMilliseconds(tokens.getPropertyValue('--motion-route')),
          easing: tokens.getPropertyValue('--ease-out').trim() || 'ease-out',
        }
      })
    })
  }
  function start() {
    if (stopPreferences) return
    readTimingAfterPaint()
    stopPreferences = listenMotionChanges(() => {
      if (document.hidden || prefersReducedMotion()) arrival?.finish()
      else readTimingAfterPaint()
    })
  }
  function stop() {
    arrival?.finish()
    cancelAnimationFrame(timingFrame)
    cancelAnimationFrame(focusFrame)
    pendingFocus = undefined
    stopPreferences?.()
    stopPreferences = undefined
    focusReturn = undefined
  }
  onMounted(start)
  onActivated(start)
  onDeactivated(stop)
  onScopeDispose(stop)
  return { onBeforeEnter, onEnter, onEnterCancelled, onLeave }
}
