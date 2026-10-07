import { onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'
import { useResizeObserver } from '@vueuse/core'
import { useVisualActivity } from './useVisualActivity'
import { startCanvasTextureParticles, type CanvasParticleMotion } from '@/utils/canvasTextureParticles'

/** One particle surface carries the old image through waiting into the decoded result.
 * Presentation never owns submission, task receipts, cancellation or results. */
export function useCanvasGenerationMotion(host: Ref<HTMLElement | null>,
  source: () => string, busy: () => boolean, comparing: () => boolean,
  progress: () => number | null, palette: () => readonly string[],
) {
  const { canAnimate, lowEffects } = useVisualActivity(host)
  const active = ref(false)
  let effect: CanvasParticleMotion | null = null
  let revision = 0
  let generationSource = ''
  let size = { width:0, height:0 }
  function stop() {
    revision++
    const current=effect; effect=null; active.value=false
    current?.stop()
  }
  function start(previousSource = source(), capturePrevious = true) {
    stop()
    const version=revision
    // The task-start URL is stable across publication/settlement Vue ticks.
    // DOM src may be runtime-resolved, so don't compare it to business URLs.
    generationSource = previousSource
    const root=host.value
    if (!root || !canAnimate.value || lowEffects.value || comparing()) return
    const candidate=capturePrevious ? root.querySelector<HTMLImageElement>('img.cg-image-target') : null
    const image=candidate?.complete && candidate.naturalWidth ? candidate : null
    const bounds=root.getBoundingClientRect(); size={width:bounds.width,height:bounds.height}
    effect=startCanvasTextureParticles(image,root,{
      generation:{progress,palette:palette()},
      onComplete:() => { if(version===revision) { effect=null; active.value=false } },
    })
    active.value=Boolean(effect)
  }
  function reveal(image: HTMLImageElement) {
    if (!canAnimate.value || lowEffects.value || comparing()) { stop(); return null }
    // Late completion or restored visibility can start from the waiting orbit.
    if (!effect) start(source(),false)
    return effect?.reveal(image) ?? null
  }
  watch([source,busy,comparing],([url,generating,comparison],[oldUrl,wasGenerating]) => {
    if (comparison) { stop(); return }
    if (generating && !wasGenerating) { start(oldUrl); return }
    if (!generating && wasGenerating && (!url || url===generationSource)) stop()
    else if (!generating && !wasGenerating && url!==oldUrl && effect) stop()
  },{flush:'pre'})
  watch([canAnimate,lowEffects],() => {
    if (!canAnimate.value || lowEffects.value) stop()
    else if (busy() && !effect) start(source(),false)
  },{flush:'sync'})
  useResizeObserver(host,() => {
    const bounds=host.value?.getBoundingClientRect()
    if (effect && bounds && (Math.abs(bounds.width-size.width)>1 || Math.abs(bounds.height-size.height)>1)) stop()
  })
  onMounted(() => { if (busy() && !effect) start() })
  onBeforeUnmount(stop)
  return { active, reveal, stop }
}
