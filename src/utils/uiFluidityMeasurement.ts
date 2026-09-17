/**
 * Opt-in local fluidity marks for plan 009 F0.
 *
 * The runtime is created only when a benchmark (or a local diagnostic page)
 * sets window.__AICS_UI_FLUIDITY__.enabled = true before the app boots. No
 * event is sent over the network; the bounded event list is read by the
 * benchmark from the same page.
 */

export type UiFluidityPhase =
  | 'intent'
  | 'feedback-committed'
  | 'shell-ready'
  | 'primary-ready'
  | 'settled'
  | 'cancelled'

export interface UiFluidityEvent {
  id: number
  phase: UiFluidityPhase
  path: string
  at: number
}

interface UiFluidityRuntime {
  enabled?: boolean
  events?: UiFluidityEvent[]
  mark?: (phase: UiFluidityPhase, path?: string) => void
}

declare global {
  interface Window {
    __AICS_UI_FLUIDITY__?: UiFluidityRuntime
  }
}

const MAX_EVENTS = 2000
let nextNavigationId = 0
let activeNavigation: { id: number; path: string; terminalPhase?: 'settled' | 'cancelled' } | null = null
const navigationByPath = new Map<string, number>()
const navigationState = new Map<number, { path: string; terminalPhase?: 'settled' | 'cancelled' }>()

function runtime(): UiFluidityRuntime | null {
  if (typeof window === 'undefined') return null
  const candidate = window.__AICS_UI_FLUIDITY__
  if (!candidate || typeof candidate !== 'object' || candidate.enabled !== true) return null
  candidate.events ||= []
  candidate.mark ||= (phase, path) => {
    const target = path || `${location.pathname}${location.search}${location.hash}`
    markUiFluidityForPath(target, phase)
  }
  return candidate
}

function record(id: number, phase: UiFluidityPhase): void {
  const state = navigationState.get(id)
  const target = runtime()
  if (!state || !target) return
  const event: UiFluidityEvent = { id, phase, path: state.path, at: performance.now() }
  target.events!.push(event)
  if (target.events!.length > MAX_EVENTS) target.events!.splice(0, target.events!.length - MAX_EVENTS)
  performance.mark(`aics-ui-fluidity-${id}-${phase}`)
  if (phase === 'settled' || phase === 'cancelled') state.terminalPhase = phase
}

function markNavigation(id: number, phase: UiFluidityPhase, path?: string): void {
  const state = navigationState.get(id)
  if (!state || !runtime()) return
  if (state.terminalPhase === 'cancelled') return
  if (state.terminalPhase === 'settled' && phase !== 'primary-ready') return
  if (path) state.path = path
  record(id, phase)
  if (activeNavigation?.id === id && state.terminalPhase) activeNavigation = null
}

export function beginUiFluidityNavigation(path: string): number | null {
  if (!runtime()) return null
  if (activeNavigation && !activeNavigation.terminalPhase) {
    markNavigation(activeNavigation.id, 'cancelled')
  }
  const id = ++nextNavigationId
  const state = { path }
  navigationState.set(id, state)
  navigationByPath.set(path, id)
  activeNavigation = { id, path }
  record(id, 'intent')
  return id
}

export function markUiFluidityNavigation(id: number | null, phase: UiFluidityPhase, path?: string): void {
  if (id === null) return
  markNavigation(id, phase, path)
}

export function markUiFluidityForPath(path: string, phase: UiFluidityPhase): void {
  const id = navigationByPath.get(path)
  if (id !== undefined) markNavigation(id, phase, path)
}

export function isUiFluidityMeasurementEnabled(): boolean {
  return runtime() !== null
}
