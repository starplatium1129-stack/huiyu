import type { ObjectDirective } from 'vue'
import { listenMotionChanges, prefersReducedMotion } from '@/utils/motionPreference'

// One animation per changed surface, never one per list item. No cloned DOM,
// delayed state update, persistent layer, or height animation during a switch.
const active = new Map<HTMLElement, Animation>()
let keyboardInput = false
function cancel(el: HTMLElement) {
  const animation = active.get(el)
  active.delete(el)
  if (animation) {
    animation.onfinish = animation.oncancel = null
    animation.cancel()
  }
}
function settle() { for (const el of active.keys()) cancel(el) }

function reveal(el: HTMLElement) {
  if (keyboardInput || document.hidden || prefersReducedMotion() || !el.isConnected || typeof el.animate !== 'function') {
    cancel(el)
    return
  }
  // v-show and route state can be read without forcing layout during Vue's patch.
  for (let parent: HTMLElement | null = el; parent; parent = parent.parentElement) {
    if (parent.hidden || parent.inert || parent.style.display === 'none' || parent.dataset.routeEntering === 'true') return
  }
  for (const surface of active.keys()) {
    if (surface !== el && surface.contains(el)) return
    if (surface !== el && el.contains(surface)) cancel(surface)
  }
  // A rapid reversal continues from the visible value rather than flashing back.
  const previous = active.has(el) ? getComputedStyle(el).opacity : '.82'
  cancel(el)
  const animation = el.animate([{ opacity: previous }, { opacity: 1 }], {
    duration:160, easing:'cubic-bezier(.23, 1, .32, 1)',
  })
  active.set(el, animation)
  animation.onfinish = animation.oncancel = () => {
    if (active.get(el) === animation) cancel(el)
  }
}

export const contentMotion: ObjectDirective<HTMLElement, unknown> = {
  mounted(el, { value }) {
    // Initial route entry already has motion. Later v-if panels may enter alone.
    if (value !== false && el.closest<HTMLElement>('.route-view')?.dataset.routeEntered === 'true') reveal(el)
  },
  updated(el, { value, oldValue }) {
    if (Object.is(value, oldValue)) return
    if (value === false) cancel(el)
    else reveal(el)
  },
  beforeUnmount: cancel,
}

/** Native details and both motion preferences share the same bounded lifecycle. */
export function installContentMotion() {
  function preference() { if (document.hidden || prefersReducedMotion()) settle() }
  function keyboard() { keyboardInput = true; settle() }
  function pointer() { keyboardInput = false }
  function toggle(event: Event) {
    if (event.target instanceof HTMLDetailsElement) reveal(event.target)
  }
  document.addEventListener('toggle', toggle, true)
  document.addEventListener('keydown', keyboard, true)
  document.addEventListener('pointerdown', pointer, true)
  const stopListening = listenMotionChanges(preference)
  return () => {
    settle()
    keyboardInput = false
    document.removeEventListener('toggle', toggle, true)
    document.removeEventListener('keydown', keyboard, true)
    document.removeEventListener('pointerdown', pointer, true)
    stopListening()
  }
}
