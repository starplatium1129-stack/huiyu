import { onActivated, onDeactivated, onMounted, onScopeDispose, watch } from 'vue'
import { useRoute } from 'vue-router'
import { navigationDirection } from '@/router/navigationItems'
import { listenMotionChanges, prefersReducedMotion } from '@/utils/motionPreference'
import { cssTimeToMilliseconds } from '@/utils/motionTiming'
import { markUiFluidityForPath } from '@/utils/uiFluidityMeasurement'

/** Release the outgoing page immediately; only the incoming content owns an animation. */
export function useRouteTransition() {
  const route = useRoute()
  let direction = 0
  watch(() => route.path, (to, from) => { direction = navigationDirection(from, to) }, { flush: 'sync' })
  let arrival: { root: HTMLElement; finish: () => void } | undefined
  let focusReturn: { origin: Element; href: string | null } | undefined
  let stopPreferences: (() => void) | undefined

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
    restoreFocus(root)
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

    const tokens = getComputedStyle(document.documentElement)
    const duration = cssTimeToMilliseconds(tokens.getPropertyValue('--motion-route'))
    if (!(duration > 0)) { finish(); return }
    const timing = { duration, easing: tokens.getPropertyValue('--ease-out').trim() || 'ease-out' }
    // Even a route whose header is still loading has a visible page transition.
    // Only opacity touches the full content so fixed tools and native canvas anchors stay put.
    effects.push(content.animate([{ opacity: 0.22 }, { opacity: 1 }], timing))
    const heading = content.querySelector<HTMLElement>('h1:not(.sr-only), [data-route-arrive] h2')
    if (heading) {
      const intro = heading.closest<HTMLElement>('header') ?? heading.parentElement
      const surface = intro && intro !== content && content.contains(intro) ? intro : heading
      effects.push(surface.animate([
        { translate: `${direction * 16}px 8px` },
        { translate: '0 0' },
      ], timing))
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
    const origin = document.activeElement
    focusReturn = origin && root.contains(origin) && origin.matches(':focus-visible')
      ? { origin, href: origin.closest<HTMLAnchorElement>('a[href]')?.href ?? null } : undefined
    onEnterCancelled(root)
    root.inert = true
    done()
  }

  function start() {
    stopPreferences ??= listenMotionChanges(() => {
      if (document.hidden || prefersReducedMotion()) arrival?.finish()
    })
  }
  function stop() {
    arrival?.finish()
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
