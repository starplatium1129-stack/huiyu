import { createFluidMotion } from './fluidSpring'

export type AnchoredSurfaceKind = 'popover' | 'select' | 'tooltip'

/** Small surfaces share a critically damped vocabulary, not a full-page slide.
 * The spring is the existing engine: retargeting preserves position and velocity.
 * Reka owns placement, transform-origin, focus and presence; we animate only its
 * visible content, never the Popper positioning wrapper or the trigger's DOM.
 */
const profiles = {
  popover: { selector: '.studio-popover', scale: .97, travel: 4, frequency: 7.2 },
  select: { selector: '.studio-select-content', scale: .98, travel: 3, frequency: 8 },
  tooltip: { selector: '.studio-tooltip', scale: .985, travel: 2, frequency: 10 },
} as const

type SurfaceState = {
  element: HTMLElement
  motion: ReturnType<typeof createFluidMotion>
  revision: number
  active: boolean
  release?: () => void
  original: { transform: string; opacity: string; willChange: string; pointerEvents: string; inert: boolean }
}

/** Native Vue Transition hooks for Reka Content (including its Presence layer).
 * Keep the same controller during cancellation; dispose only after a completed
 * leave or component teardown. Do not replace cancelled motion with a new spring.
 */
export function createAnchoredSurfaceMotion(kind: AnchoredSurfaceKind) {
  const profile = profiles[kind]
  const states = new Map<Element, SurfaceState>()

  function restore(state: SurfaceState) {
    const { element, original } = state
    element.style.transform = original.transform
    element.style.opacity = original.opacity
    element.style.willChange = original.willChange
    element.style.pointerEvents = original.pointerEvents
    element.inert = original.inert
  }

  function stateFor(root: Element, initial: number): SurfaceState | undefined {
    const existing = states.get(root)
    if (existing) return existing
    // Some primitives expose a positioning wrapper as their transition root.
    // Resolving the labelled surface avoids clobbering Floating UI's transform.
    const element = root.matches(profile.selector)
      ? root as HTMLElement
      : root.querySelector<HTMLElement>(profile.selector)
    if (!element) return undefined
    const original = {
      transform: element.style.transform, opacity: element.style.opacity,
      willChange: element.style.willChange, pointerEvents: element.style.pointerEvents,
      inert: element.inert,
    }
    const baseOpacity = original.opacity === '' ? 1 : Number(original.opacity)
    const baseTransform = original.transform && original.transform !== 'none' ? `${original.transform} ` : ''
    const state: SurfaceState = {
      element, original, revision: 0, active: false,
      motion: createFluidMotion([initial], ([progress]) => {
        // The shared engine can settle on a preference/visibility event even at
        // rest. Do not recreate a transform after an open surface was cleaned up.
        if (!state.active) return
        const remaining = 1 - progress
        const travel = remaining * profile.travel
        const side = element.dataset.side || 'bottom'
        const x = side === 'left' ? travel : side === 'right' ? -travel : 0
        const y = side === 'top' ? travel : side === 'bottom' ? -travel : 0
        element.style.opacity = String(Math.max(0, Math.min(1, progress)) * baseOpacity)
        element.style.transform = `${baseTransform}translate(${x}px, ${y}px) scale(${1 - (1 - profile.scale) * remaining})`
      }, profile.frequency),
    }
    states.set(root, state)
    return state
  }

  function transition(root: Element, target: 0 | 1, done: () => void) {
    const state = stateFor(root, target === 1 ? 0 : 1)
    if (!state) { done(); return }
    // Increment before .to(): its superseded callback must not restore styles
    // belonging to the new phase. Vue's callbacks are released exactly once.
    const revision = ++state.revision
    let released = false
    const release = () => { if (!released) { released = true; done() } }
    state.release = release
    state.active = true
    state.element.style.willChange = [state.original.willChange === 'auto' ? '' : state.original.willChange, 'transform', 'opacity'].filter(Boolean).join(', ')
    state.element.inert = target === 0 || state.original.inert
    state.element.style.pointerEvents = target === 0 ? 'none' : state.original.pointerEvents
    state.motion.to([target], false, () => {
      if (states.get(root) === state && state.revision === revision) {
        state.active = false
        state.release = undefined
        if (target === 1) restore(state)
      }
      release()
    })
  }

  function dispose(root: Element) {
    const state = states.get(root)
    if (!state) return
    state.active = false
    state.revision++
    state.motion.dispose()
    restore(state)
    states.delete(root)
    // A portalled DOM node may still be awaiting Vue's leave callback. Release
    // it on owner teardown as well; cancelling rAF alone can strand that node.
    const release = state.release
    state.release = undefined
    release?.()
  }

  return {
    enter: (root: Element, done: () => void) => transition(root, 1, done),
    leave: (root: Element, done: () => void) => transition(root, 0, done),
    afterLeave: dispose,
    dispose() { for (const root of states.keys()) dispose(root) },
  }
}
