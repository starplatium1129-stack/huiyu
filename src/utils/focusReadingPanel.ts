import { scrollBehavior } from './motionPreference'

/** A visible reader can take focus without scrolling its adjacent choices away. */
export function focusReadingPanel(panel: HTMLElement | null) {
  if (!panel?.isConnected || panel.closest('[inert]')) return
  panel.focus({ preventScroll: true })
  const heading = panel.querySelector('header')?.getBoundingClientRect()
  const inset = parseFloat(getComputedStyle(panel).scrollMarginTop) || 0
  if (heading && (heading.top < inset || heading.bottom > window.innerHeight)) {
    panel.scrollIntoView({ block: 'start', behavior: scrollBehavior() })
  }
}
