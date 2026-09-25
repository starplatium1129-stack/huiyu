import { ENTRANCE_MAX_MS } from '@/composables/live2d/constants'
import type { Live2DCtx } from '@/composables/live2d/context'
import { prefersReducedMotion } from '@/utils/motionPreference'
import { isCatchable } from './lifecycleUtils'

/** Owns the browser-side entrance-motion retry loop and its cancellable timer. */
export function createEntranceController(ctx: Live2DCtx, getGeneration: () => number) {
  let timer = 0

  function cancel() {
    clearTimeout(timer)
    timer = 0
  }

  function play() {
    cancel()
    if (prefersReducedMotion() || !ctx.model) return
    const motionFn = ctx.model.motion
    const generation = getGeneration()
    if (typeof motionFn !== 'function') return
    // Native backends own entrance playback; this loop is browser-only.
    const entranceGroup = ctx.adapter?.entranceGroup
    if (!entranceGroup || !(ctx.model.hasMotionGroup?.(entranceGroup) ?? false)) return

    let attempts = 0
    const tryStart = () => {
      if (attempts++ > 40 || generation !== getGeneration() || !ctx.enabled.value || ctx.destroyed.value || !ctx.model) return
      const result = motionFn.call(ctx.model, entranceGroup, undefined, 2)
      const started = isCatchable(result)
        ? result.then((value: unknown) => value === true).catch(() => false)
        : Promise.resolve(result === true)
      void started.then((ok: boolean) => {
        if (generation !== getGeneration() || !ctx.enabled.value || ctx.destroyed.value) return
        if (ok) {
          ctx.entranceUntil = performance.now() + ENTRANCE_MAX_MS
          return
        }
        timer = window.setTimeout(tryStart, 250)
      })
    }
    tryStart()
  }

  return { play, cancel }
}
