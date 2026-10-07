import type { ObjectDirective } from 'vue'
import { listenMotionChanges, prefersReducedMotion } from '@/utils/motionPreference'

// One animation per changed surface, never one per list item. No cloned DOM,
// delayed state update, persistent layer, or height animation during a switch.
const active = new Map<HTMLElement, Animation>()
const pending = new Map<HTMLElement, number>()
let keyboardInput = false
function cancel(el: HTMLElement) {
  const frame = pending.get(el)
  if (frame !== undefined) cancelAnimationFrame(frame)
  pending.delete(el)
  const animation = active.get(el)
  active.delete(el)
  if (animation) {
    animation.onfinish = animation.oncancel = null
    animation.cancel()
  }
}
function settle() { for (const el of new Set([...active.keys(), ...pending.keys()])) cancel(el) }
function scheduleReveal(el: HTMLElement, direction?: string, deferred = false) {
  if (!deferred) { reveal(el, direction); return }
  cancel(el)
  // Album navigation finishes its DOM, focus and scroll work before starting
  // the timeline; cold option/media setup must not consume the visible fade.
  pending.set(el, requestAnimationFrame(() => { pending.delete(el); reveal(el, direction, true) }))
}

function reveal(el: HTMLElement, direction = 'up', holdFirstFrame = false) {
  if (document.hidden || prefersReducedMotion() || !el.isConnected || typeof el.animate !== 'function'
    || direction && el.matches('input, textarea') && document.activeElement === el) {
    cancel(el)
    return
  }
  // v-show and route state can be read without forcing layout during Vue's patch.
  for (let parent: HTMLElement | null = el; parent; parent = parent.parentElement) {
    if (parent.hidden || parent.inert || parent.style.display === 'none' || parent.dataset.routeEntering === 'true') { cancel(el); return }
  }
  for (const surface of active.keys()) {
    if (surface !== el && surface.contains(el)) return
    if (surface !== el && el.contains(surface)) cancel(surface)
  }
  // A rapid reversal continues from the visible value rather than flashing back.
  const previous = active.has(el) ? getComputedStyle(el) : null
  const start: Keyframe = { opacity: previous?.opacity ?? '.35' }
  const end: Keyframe = { opacity: 1 }
  const offsets: Record<string, string> = { left: 'translateX(-12px)', right: 'translateX(12px)', up: 'translateY(12px)', down: 'translateY(-12px)' }
  if (!keyboardInput && direction && offsets[direction]) {
    start.transform = previous?.transform ?? offsets[direction]
    end.transform = 'none'
  }
  cancel(el)
  const animation = el.animate([start, end], {
    duration:keyboardInput ? 160 : 320, easing:'cubic-bezier(.22, 1, .36, 1)',
    ...(holdFirstFrame ? { fill:'both' as const } : {}),
  })
  active.set(el, animation)
  if (holdFirstFrame) {
    animation.pause(); animation.currentTime = 0
    pending.set(el, requestAnimationFrame(() => {
      pending.delete(el)
      if (active.get(el) === animation) animation.play()
    }))
  }
  animation.onfinish = animation.oncancel = () => {
    if (active.get(el) === animation) cancel(el)
  }
}

export const contentMotion: ObjectDirective<HTMLElement, unknown> = {
  mounted(el, { value, arg, modifiers }) {
    // Initial route entry already has motion. Later v-if panels may enter alone.
    if (value !== false && (!el.closest('.route-view') || el.closest<HTMLElement>('.route-view')?.dataset.routeEntered === 'true')) scheduleReveal(el, arg, modifiers?.defer)
  },
  updated(el, { value, oldValue, arg, modifiers }) {
    if (Object.is(value, oldValue)) return
    if (value === false) cancel(el)
    else scheduleReveal(el, arg, modifiers?.defer)
  },
  beforeUnmount: cancel,
}

/** Native details and both motion preferences share the same bounded lifecycle. */
export function installContentMotion() {
  function preference() { if (document.hidden || prefersReducedMotion()) settle() }
  function keyboard() { keyboardInput = true; settle() }
  function pointer(event: Event) {
    keyboardInput = false
    if (!(event.target instanceof Node)) return
    // A chosen child panel owns the next frame. Otherwise the active ancestor
    // below suppresses its reveal, making a quick second selection look inert.
    for (const el of active.keys()) if (el.contains(event.target)) cancel(el)
  }
  function toggle(event: Event) {
    if (!(event.target instanceof HTMLDetailsElement)) return
    const details = event.target
    const body = details.querySelector<HTMLElement>(':scope > [data-disclosure-content]')
      ?? [...details.children].find((child): child is HTMLElement => child instanceof HTMLElement && child.tagName !== 'SUMMARY')
    if (!body) return
    if (details.open) reveal(body)
    else cancel(body)
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
