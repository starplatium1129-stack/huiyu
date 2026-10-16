import { onActivated, onDeactivated, onMounted, onScopeDispose, readonly, shallowRef } from 'vue'
import { listenMotionChanges, prefersReducedMotion } from '@/utils/motionPreference'

/** Keep component effects in sync with the system and the user's live override. */
export function useMotionPreference() {
  const reduced = shallowRef(prefersReducedMotion())
  let release: (() => void) | undefined
  const update = () => { reduced.value = prefersReducedMotion() }
  function start() { update(); release ??= listenMotionChanges(update) }
  function stop() { release?.(); release = undefined }
  onMounted(start)
  onActivated(start)
  onDeactivated(stop)
  onScopeDispose(stop)
  return readonly(reduced)
}
