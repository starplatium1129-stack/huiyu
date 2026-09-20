import { onActivated, onDeactivated, ref } from 'vue'

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
  let systemReducedMotion = false

  function syncEffectsPreference(rebuild = true) {
    const root = document.documentElement
    const next = root.dataset.fluidEffects === 'low' || root.dataset.reducedGlass === 'true'
    const nextMotion = systemReducedMotion || root.dataset.reducedMotion === 'true'
    if (next === lowEffects.value && nextMotion === reduceMotion.value) return
    lowEffects.value = next
    reduceMotion.value = nextMotion
    if (!rebuild || !active.value) return
    hooks.stop()
    hooks.rebuild()
    hooks.start()
  }

  function onRootPreferenceChanged() {
    syncEffectsPreference()
    hooks.paletteChanged()
  }

  function onVisibilityChange() {
    if (document.hidden) hooks.stop()
    else if (active.value && hooks.visible()) hooks.start()
  }

  function onMotionPreference(event: MediaQueryListEvent | MediaQueryList) {
    systemReducedMotion = event.matches
    syncEffectsPreference()
  }

  onActivated(() => {
    active.value = true
    syncEffectsPreference(false)
    hooks.resize()
    hooks.start()
  })
  onDeactivated(() => {
    active.value = false
    hooks.stop()
    hooks.cancelDeferred()
  })

  return { lowEffects, reduceMotion, active, syncEffectsPreference, onRootPreferenceChanged, onVisibilityChange, onMotionPreference }
}
