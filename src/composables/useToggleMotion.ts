import { onActivated, onDeactivated, onMounted, onScopeDispose, watch } from 'vue'
import { createFluidMotion } from '@/utils/fluidSpring'
import { TOGGLE_SPRING } from '@/utils/controlSprings'

/** Binary control artwork follows one continuous spring; native state commits
 * immediately. CSS reversing-shortening must not accelerate repeated presses. */
export function useToggleMotion(selected: () => boolean, paint: (progress: number) => void) {
  let motion: ReturnType<typeof createFluidMotion> | undefined
  function start() {
    if (motion) return
    const initial = Number(selected())
    motion = createFluidMotion([initial], ([progress]) => paint(progress), TOGGLE_SPRING.frequency, TOGGLE_SPRING.damping)
    paint(initial)
  }
  function stop() {
    motion?.dispose()
    motion = undefined
    paint(Number(selected()))
  }
  watch(selected, value => motion?.to([Number(value)]), { flush: 'post' })
  onMounted(start)
  onActivated(start)
  onDeactivated(stop)
  onScopeDispose(stop)
}
