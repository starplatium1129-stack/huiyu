import { onBeforeUnmount } from 'vue'
import { createAnchoredSurfaceMotion, type AnchoredSurfaceKind } from '@/utils/anchoredSurfaceMotion'

/** One controller per primitive; no global listeners survive component teardown. */
export function useAnchoredSurfaceMotion(kind: AnchoredSurfaceKind) {
  const motion = createAnchoredSurfaceMotion(kind)
  onBeforeUnmount(motion.dispose)
  return motion
}
