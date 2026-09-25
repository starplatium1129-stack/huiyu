import { onActivated, onDeactivated, onMounted, onUnmounted, type Ref } from 'vue'

export interface ParticleLifecycleHooks {
  start(): void
  stop(): void
  resize(): void
  palette(): void
  preference(): void
  visible(value: boolean): void
  portrait(): void
  invalidate(): void
}

/** Per-field ownership only; rendering still uses the existing shared scheduler. */
export function useParticleLifecycle(host: Ref<HTMLElement | null>, hooks: ParticleLifecycleHooks) {
  let generation = 0
  let active = false, paletteFrame: number | null = null
  let resize: ResizeObserver | undefined, intersection: IntersectionObserver | undefined, theme: MutationObserver | undefined
  let removeMedia: (() => void) | undefined
  function cancelPalette() { if (paletteFrame !== null) cancelAnimationFrame(paletteFrame); paletteFrame = null }
  function palette() {
    if (!active || document.hidden || paletteFrame !== null) return
    paletteFrame = requestAnimationFrame(() => { paletteFrame = null; if (active && !document.hidden) hooks.palette() })
  }
  function preference() { if (active) hooks.preference() }
  function visibility() {
    if (!active) return
    if (document.hidden) { cancelPalette(); hooks.stop() }
    else { hooks.palette(); hooks.resize(); hooks.start() }
  }
  function start() {
    if (active || !host.value) return
    active = true
    const token = ++generation
    const current = () => active && token === generation
    const media = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null
    if (typeof media?.addEventListener === 'function') {
      media.addEventListener('change', preference)
      removeMedia = () => media.removeEventListener('change', preference)
    } else if (typeof media?.addListener === 'function') {
      media.addListener(preference); removeMedia = () => media.removeListener(preference)
    }
    if (typeof ResizeObserver === 'function') {
      resize = new ResizeObserver(() => { if (current() && !document.hidden) hooks.resize() })
      resize.observe(host.value)
    }
    if (typeof IntersectionObserver === 'function') {
      intersection = new IntersectionObserver(([entry]) => {
        if (!current()) return
        const visible = entry?.isIntersecting ?? true
        hooks.visible(visible)
        if (visible && !document.hidden) hooks.start()
        else hooks.stop()
      }, { rootMargin: '120px' })
      intersection.observe(host.value)
    }
    if (typeof MutationObserver === 'function') {
      theme = new MutationObserver(() => { if (current()) palette() })
      theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    }
    window.addEventListener('atelier:motion-preference', preference)
    document.addEventListener('visibilitychange', visibility)
    preference(); hooks.palette(); hooks.resize(); hooks.portrait(); hooks.start()
  }
  function stop() {
    if (!active) return
    active = false; generation++
    cancelPalette(); hooks.stop(); hooks.invalidate()
    resize?.disconnect(); intersection?.disconnect(); theme?.disconnect(); removeMedia?.()
    resize = undefined; intersection = undefined; theme = undefined; removeMedia = undefined
    window.removeEventListener('atelier:motion-preference', preference)
    document.removeEventListener('visibilitychange', visibility)
  }
  onMounted(start); onActivated(start); onDeactivated(stop); onUnmounted(stop)
  return { isActive: () => active }
}
