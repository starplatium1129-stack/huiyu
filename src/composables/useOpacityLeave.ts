import { onBeforeUnmount, onDeactivated } from 'vue'
import { createContentSpring } from '@/utils/contentSpring'
import { listenMotionChanges, prefersReducedMotion } from '@/utils/motionPreference'

/** Decoded thumbnails release their skeleton without Vue's body-wide CSS reflow. */
export function useOpacityLeave() {
  const active = new Map<Element, () => void>()
  let stopPreference: (() => void) | undefined
  function cancel(element: Element) { active.get(element)?.() }
  function finishAll() { for (const finish of [...active.values()]) finish() }
  function leave(element: Element, done: () => void) {
    cancel(element)
    if (document.hidden || prefersReducedMotion()) { done(); return }
    const motion = createContentSpring(element as HTMLElement, [1], ([opacity]) => ({ opacity }), { opacity: 0 })
    const finish = () => {
      if (active.get(element) !== finish) return
      active.delete(element); motion.cancel(); done()
      if (!active.size) { stopPreference?.(); stopPreference = undefined }
    }
    active.set(element, finish)
    stopPreference ??= listenMotionChanges(() => { if (document.hidden || prefersReducedMotion()) finishAll() })
    motion.to([0], finish)
  }
  onDeactivated(finishAll)
  onBeforeUnmount(finishAll)
  return { leave, cancel }
}
