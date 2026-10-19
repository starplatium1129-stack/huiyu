import type { ObjectDirective } from 'vue'
import { listenMotionChanges, prefersReducedMotion } from '@/utils/motionPreference'
import { createContentSpring, type ContentSpring } from '@/utils/contentSpring'

// One owner per reading surface; state changes never wait for motion.
const active = new Map<HTMLElement, { motion: ContentSpring; base: string }>()
const pending = new Map<HTMLElement, number>()
function cancel(el: HTMLElement) {
  const frame = pending.get(el)
  if (frame !== undefined) cancelAnimationFrame(frame)
  pending.delete(el)
  active.get(el)?.motion.cancel(); active.delete(el)
}
function settle(root?: HTMLElement) {
  for (const el of new Set([...active.keys(), ...pending.keys()])) if (!root || root.contains(el)) cancel(el)
}
function scheduleReveal(el: HTMLElement, direction?: string, deferred = false) {
  const frame = pending.get(el)
  if (frame !== undefined) cancelAnimationFrame(frame)
  pending.delete(el)
  // An active surface retargets in this patch; deferring would expose a stale pose.
  if (!deferred || active.has(el)) { reveal(el, direction); return }
  pending.set(el, requestAnimationFrame(() => { pending.delete(el); reveal(el, direction) }))
}
function reveal(el: HTMLElement, direction = 'up') {
  if (document.hidden || prefersReducedMotion() || !el.isConnected
    || el.matches('input, textarea') && document.activeElement === el) { cancel(el); return }
  for (let parent: HTMLElement | null = el; parent; parent = parent.parentElement) {
    if (parent.hidden || parent.inert || parent.style.display === 'none'
      || parent instanceof HTMLDialogElement && !parent.open || parent.dataset.routeEntering === 'true') { cancel(el); return }
  }
  // A parent arrival already moves its content. Do not stack a second reveal.
  for (const surface of active.keys()) {
    if (surface !== el && surface.contains(el)) return
    if (surface !== el && el.contains(surface)) cancel(surface)
  }
  const previous = active.get(el)
  const state = previous?.motion.capture()
  const transform = previous ? previous.base : getComputedStyle(el).transform
  const base = transform === 'none' ? '' : transform
  cancel(el)
  const offsets: Record<string, number[]> = { left: [-12, 0], right: [12, 0], up: [0, 12], down: [0, -12] }
  const offset = offsets[direction]
  const motion = createContentSpring(el, state?.values ?? [...(offset ?? [0, 0]), .8], ([x, y, opacity]) => ({
    opacity, ...(offset ? { transform: `translate(${x}px, ${y}px) ${base}` } : {}),
  }), { velocities: state?.velocities, opacity: 2 })
  active.set(el, { motion, base })
  motion.to([0, 0, 1], () => { if (active.get(el)?.motion === motion) cancel(el) })
}
export const contentMotion: ObjectDirective<HTMLElement, unknown> = {
  mounted(el, { value, arg, modifiers }) {
    if (value !== false && (!el.closest('.route-view') || el.closest<HTMLElement>('.route-view')?.dataset.routeEntered === 'true')) scheduleReveal(el, arg, modifiers?.defer)
  },
  updated(el, { value, oldValue, arg, modifiers }) {
    if (Object.is(value, oldValue)) return
    if (value === false) cancel(el)
    else scheduleReveal(el, arg, modifiers?.defer)
  },
  beforeUnmount: cancel,
}
/** Native disclosures share the same spring and reduced-motion lifecycle. */
export function installContentMotion() {
  function preference() { if (document.hidden || prefersReducedMotion()) settle() }
  function nativeClose(event: Event) {
    if (event.target instanceof HTMLDialogElement && !event.target.open) settle(event.target)
  }
  function toggle(event: Event) {
    if (!(event.target instanceof HTMLDetailsElement)) return
    const details = event.target
    const body = details.querySelector<HTMLElement>(':scope > [data-disclosure-content]')
      ?? [...details.children].find((child): child is HTMLElement => child instanceof HTMLElement && child.tagName !== 'SUMMARY')
    if (!body) return
    if (details.open) reveal(body, 'down')
    else cancel(body)
  }
  document.addEventListener('toggle', toggle, true)
  document.addEventListener('close', nativeClose, true)
  const stopListening = listenMotionChanges(preference)
  return () => { settle(); document.removeEventListener('toggle', toggle, true); document.removeEventListener('close', nativeClose, true); stopListening() }
}
