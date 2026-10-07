import { onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'
import { useResizeObserver } from '@vueuse/core'
import { useVisualActivity } from './useVisualActivity'
import { startCanvasTextureParticles, type CanvasParticleMotion, type GenerationContinuation } from '@/utils/canvasTextureParticles'

/** Break up the old image, then hand off to the shared waiting visual.
 * Presentation never owns submission, task receipts, cancellation or results. */
export function useCanvasGenerationMotion(host: Ref<HTMLElement | null>,
  source: () => string, busy: () => boolean, comparing: () => boolean,
  progress: () => number | null, palette: () => readonly string[],
) {
  const { canAnimate, lowEffects } = useVisualActivity(host)
  const active = ref(false)
  const continuation = ref<GenerationContinuation>()
  let effect: CanvasParticleMotion | null = null
  let generationSource = ''
  let size = { width:0, height:0 }
  function stop() {
    const current=effect; effect=null; active.value=false
    current?.stop()
  }
  function start(previousSource = source()) {
    stop()
    continuation.value=undefined
    // The task-start URL is stable across publication/settlement Vue ticks.
    // DOM src may be runtime-resolved, so don't compare it to business URLs.
    generationSource = previousSource
    const root=host.value
    if (!root || !canAnimate.value || lowEffects.value || comparing()) return
    const image=root.querySelector<HTMLImageElement>('img.cg-image-target')
    // An empty canvas belongs to GenerationParticles. Claiming it here hides
    // that waiting visual even though there is no artwork to dissolve.
    if (!image?.complete || !image.naturalWidth) return
    const bounds=root.getBoundingClientRect(); size={width:bounds.width,height:bounds.height}
    effect=startCanvasTextureParticles(image,root,{
      generation:{progress,palette:palette()},
      onHandoff:state => { continuation.value=state; active.value=false },
      onComplete:() => { effect=null; active.value=false },
    })
    active.value=Boolean(effect)
  }
  watch([source,busy,comparing],([url,generating,comparison],[oldUrl,wasGenerating]) => {
    if (comparison) { stop(); return }
    if (generating && !wasGenerating) { start(oldUrl); return }
    if (!generating && wasGenerating && (!url || url===generationSource)) stop()
    else if (!generating && !wasGenerating && url!==oldUrl && effect) stop()
  },{flush:'pre'})
  watch([canAnimate,lowEffects],() => {
    if (!canAnimate.value || lowEffects.value) stop()
  },{flush:'sync'})
  useResizeObserver(host,() => {
    const bounds=host.value?.getBoundingClientRect()
    if (effect && bounds && (Math.abs(bounds.width-size.width)>1 || Math.abs(bounds.height-size.height)>1)) stop()
  })
  onMounted(() => { if (busy()) start() })
  onBeforeUnmount(stop)
  return { active, continuation, release:stop, stop }
}
