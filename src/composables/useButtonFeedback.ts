import { onMounted, onUnmounted } from 'vue'
import { frame, cancelFrame, spring, type FrameData } from 'motion'
import { BUTTON_SPRING } from '@/utils/controlSprings'
import { listenMotionChanges, prefersReducedMotion } from '@/utils/motionPreference'

// Authored generation/action-link animations keep ownership of their surfaces.
const SELECTOR = '.btn:not(.generation-action):not(.studio-action-link), [data-spring-button]'
type Feedback = {
  button: HTMLElement; surface: HTMLElement; value: number
  generator?: ReturnType<typeof spring>; started: number | null; elapsed: number; moving: boolean
  pointer: number; pressed: boolean
  contents: { element: HTMLElement | SVGElement; scale: string }[]
}

/** Delegated visual feedback: native click, keyboard activation and hit boxes stay intact. */
export function useButtonFeedback() {
  const active = new Map<HTMLElement, Feedback>()
  let stopPreference: (() => void) | undefined
  let running = false

  function stopFrame() { cancelFrame(tick); running = false }

  function remove(button: HTMLElement) {
    const state = active.get(button)
    if (!state) return
    active.delete(button)
    state.surface.remove()
    for (const { element, scale } of state.contents) element.style.scale = scale
    if (![...active.values()].some(item => item.moving)) stopFrame()
  }
  function clear() { for (const button of active.keys()) remove(button) }
  function unavailable(button: HTMLElement) {
    return !button.isConnected || button.matches(':disabled,[aria-disabled="true"],[data-disabled]')
      || Boolean(button.closest('[inert]'))
  }
  function paint(state: Feedback, value: number) {
    state.value = value
    state.surface.style.opacity = String(Math.max(0, Math.min(1, value)))
    state.surface.style.transform = `scale(${1 - value * .05})`
    // Individual scale composes with authored transforms; the button never moves.
    for (const { element } of state.contents) element.style.scale = String(1 - value * .04)
  }
  function retarget(state: Feedback, pressed: boolean) {
    state.pressed = pressed
    const velocity = state.moving ? state.generator?.velocity?.(state.elapsed) ?? 0 : 0
    // Motion's analytic generator retains presentation and velocity on rapid reversals.
    state.generator = spring({
      ...BUTTON_SPRING, keyframes: [state.value, pressed ? 1 : 0], velocity, restDelta: .001, restSpeed: .01,
    })
    state.started = null; state.elapsed = 0; state.moving = true
    if (!running) { running = true; frame.update(tick, true) }
  }
  function tick({ timestamp }: FrameData) {
    for (const state of active.values()) {
      if (unavailable(state.button)) { remove(state.button); continue }
      if (!state.moving || !state.generator) continue
      state.started ??= timestamp - 1000 / 60
      state.elapsed = timestamp - state.started
      const { value, done } = state.generator.next(state.elapsed)
      paint(state, value)
      if (done) { state.moving = false; if (!state.pressed) remove(state.button) }
    }
    if (![...active.values()].some(state => state.moving)) stopFrame()
  }
  function press(event: PointerEvent) {
    if (event.button !== 0 || !event.isPrimary || event.ctrlKey || event.metaKey || event.altKey
      || document.hidden || prefersReducedMotion() || !(event.target instanceof Element)) return
    const button = event.target.closest<HTMLElement>(SELECTOR)
    if (!button || unavailable(button) || button.matches('[aria-busy="true"]')) return
    const current = active.get(button)
    if (current) { current.pointer = event.pointerId; retarget(current, true); return }
    const surface = document.createElement('span')
    surface.className = 'studio-button-feedback'
    surface.setAttribute('aria-hidden', 'true')
    button.append(surface)
    // Explicit content wrappers can compress together; plain-text buttons use the rim.
    const contents = [...button.querySelectorAll<HTMLElement | SVGElement>(':scope > [data-press-content], :scope > .archive-icon')]
      .map(element => ({ element, scale: element.style.scale }))
    const state: Feedback = { button, surface, value: 0, contents, pointer: event.pointerId, pressed: true, started: null, elapsed: 0, moving: false }
    active.set(button, state)
    // Even a down/up within one frame gets immediate contact feedback.
    paint(state, .35)
    retarget(state, true)
  }
  function release(event: PointerEvent) {
    for (const state of active.values()) if (state.pointer === event.pointerId && state.pressed) retarget(state, false)
  }
  function leave(event: PointerEvent) {
    for (const state of active.values()) if (state.pressed && state.button.contains(event.target as Node)
      && (!(event.relatedTarget instanceof Node) || !state.button.contains(event.relatedTarget))) retarget(state, false)
  }
  onMounted(() => {
    document.documentElement.dataset.buttonFeedback = 'spring'
    document.addEventListener('pointerdown', press, true)
    document.addEventListener('pointerup', release, true)
    document.addEventListener('pointercancel', release, true)
    document.addEventListener('pointerout', leave, true)
    document.addEventListener('keydown', clear, true)
    window.addEventListener('blur', clear)
    stopPreference = listenMotionChanges(() => { if (document.hidden || prefersReducedMotion()) clear() })
  })
  onUnmounted(() => {
    clear(); stopPreference?.()
    delete document.documentElement.dataset.buttonFeedback
    document.removeEventListener('pointerdown', press, true)
    document.removeEventListener('pointerup', release, true)
    document.removeEventListener('pointercancel', release, true)
    document.removeEventListener('pointerout', leave, true)
    document.removeEventListener('keydown', clear, true)
    window.removeEventListener('blur', clear)
  })
}
