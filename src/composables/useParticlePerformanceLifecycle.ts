import { onActivated, onDeactivated, ref } from 'vue'
import { prefersReducedMotion } from '@/utils/motionPreference'

interface ParticlePerformanceHooks {
  rebuild: () => void
  start: () => void
  stop: () => void
  resize: () => void
  cancelDeferred: () => void
  paletteChanged: () => void
  visible: () => boolean
}

/** Owns low-effects and KeepAlive lifecycle for decorative particle canvases. */
export function useParticlePerformanceLifecycle(hooks: ParticlePerformanceHooks) {
  const lowEffects = ref(false)
  const reduceMotion = ref(false)
  const active = ref(true)

  function startIfVisible() {
    if (active.value && !reduceMotion.value && !document.hidden && hooks.visible()) hooks.start()
  }

  function syncEffectsPreference(rebuild = true) {
    const root = document.documentElement
    const next = root.dataset.fluidEffects === 'low' || root.dataset.reducedGlass === 'true'
    if (next === lowEffects.value) return
    lowEffects.value = next
    if (!rebuild || !active.value) return
    hooks.stop()
    hooks.rebuild()
    startIfVisible()
  }

  function onRootPreferenceChanged() {
    syncMotionPreference()
    syncEffectsPreference()
    if (active.value) hooks.paletteChanged()
  }

  function onVisibilityChange() {
    if (document.hidden) hooks.stop()
    else startIfVisible()
  }

  function syncMotionPreference(rebuild = true) {
    const next = prefersReducedMotion()
    if (next === reduceMotion.value) return
    reduceMotion.value = next
    if (!rebuild || !active.value) return
    hooks.stop()
    hooks.rebuild()
    startIfVisible()
  }

  function onMotionPreference(_event: MediaQueryListEvent | MediaQueryList) {
    syncMotionPreference()
  }

  onActivated(() => {
    active.value = true
    syncMotionPreference(false)
    syncEffectsPreference(false)
    hooks.resize()
    startIfVisible()
  })
  onDeactivated(() => {
    active.value = false
    hooks.stop()
    hooks.cancelDeferred()
  })

  return { lowEffects, reduceMotion, active, syncEffectsPreference, onRootPreferenceChanged, onVisibilityChange, onMotionPreference }
}
