import { onBeforeUnmount, ref, watch, type Ref } from 'vue'
import { useResizeObserver } from '@vueuse/core'
import type { CanvasParticleMotion } from '@/utils/canvasTextureParticles'
import type { GenerationOrbitSurface } from '@/utils/generationOrbit'

/** The live orbit owns the wait. Only departing and arriving images need a texture surface. */
export function useCanvasGenerationMotion(host: Ref<HTMLElement | null>, enabled: Readonly<Ref<boolean>>,
  source: () => string, busy: () => boolean, comparing: () => boolean,
  progress: () => number | null, palette: () => readonly string[], resultPalette: () => readonly string[],
  orbit: () => GenerationOrbitSurface | null,
) {
  const active = ref(false)
  let effect: CanvasParticleMotion | null = null
  let startParticles: typeof import('@/utils/canvasTextureParticles')['startCanvasTextureParticles'] | undefined
  let generationSource = ''
  function stop() {
    effect?.stop()
    effect = null
    active.value = false
  }
  function start(image: HTMLImageElement | null) {
    if (!host.value || !enabled.value || comparing() || !startParticles) return null
    effect = startParticles(image, host.value, {
      generation: { progress, palette: palette(), orbit },
      onComplete: () => { effect = null; active.value = false },
    })
    active.value = !!effect
    return effect
  }
  watch([source, busy, enabled], () => {
    if (!startParticles && enabled.value && (source() || busy()))
      void import('@/utils/canvasTextureParticles').then(module => { startParticles = module.startCanvasTextureParticles }).catch(() => {})
  }, { immediate: true })
  watch([source, busy, comparing], ([url, generating, comparison], [previous, wasGenerating]) => {
    if (comparison) { stop(); return }
    if (generating && !wasGenerating) {
      stop()
      generationSource = previous
      const image = host.value?.querySelector<HTMLImageElement>('img.cg-image-target')
      if (image?.complete && image.naturalWidth) start(image)
    } else if (!generating && (wasGenerating ? !url || url === generationSource : url !== previous)) stop()
  })
  watch(enabled, allowed => { if (!allowed) stop() }, { flush: 'sync' })
  useResizeObserver(host, () => effect?.resize())
  onBeforeUnmount(stop)
  function reveal(image: HTMLImageElement, duration: number) {
    return (effect ?? start(null))?.reveal(image, duration, resultPalette()) ?? null
  }
  return { active, reveal, stop }
}
