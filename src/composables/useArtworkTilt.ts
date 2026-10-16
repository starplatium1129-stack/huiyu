import { onDeactivated, onScopeDispose, type Ref } from 'vue'
import { listenMotionChanges, prefersReducedMotion } from '@/utils/motionPreference'

// Inspira UI 3D Card, adapted to an illustration plane with a stationary link.
// Source: unovue/inspira-ui@04c57ab62b9713872ebbf68988dff1836ed3d764,
// app/components/inspira/ui/card-3d/CardContainer.vue; MIT: assets/licenses/inspira-ui.txt.
export function useArtworkTilt(plane: Ref<HTMLElement | null>) {
  let host: HTMLElement | null = null
  let pending = 0, x = 0, y = 0
  let release: (() => void) | undefined
  function reset(event?: Event) {
    const next = (event as PointerEvent | undefined)?.relatedTarget
    if (event?.type === 'pointerleave' && next instanceof Node && host?.contains(next)) return
    host = null
    cancelAnimationFrame(pending); pending = 0
    plane.value?.style.removeProperty('transform')
    release?.(); release = undefined
    document.removeEventListener('keydown', reset, true)
    document.removeEventListener('scroll', reset, true)
    window.removeEventListener('resize', reset)
  }
  function move(event: PointerEvent) {
    if (!host || event.pointerType === 'touch') return
    x = event.clientX; y = event.clientY
    if (pending) return
    pending = requestAnimationFrame(() => {
      pending = 0
      if (!host?.isConnected || host.closest('[inert], [hidden]')) { reset(); return }
      const rect = host.getBoundingClientRect()
      if (!rect.width || !rect.height) { reset(); return }
      const horizontal = Math.max(-.5, Math.min(.5, (x - rect.left) / rect.width - .5))
      const vertical = Math.max(-.5, Math.min(.5, (y - rect.top) / rect.height - .5))
      if (plane.value) plane.value.style.transform = `perspective(900px) rotateX(${-vertical * 12}deg) rotateY(${horizontal * 16}deg) translateY(-10px)`
    })
  }
  function enter(event: PointerEvent) {
    if (event.pointerType === 'touch' || document.hidden || prefersReducedMotion()
      || !matchMedia('(hover:hover) and (pointer:fine)').matches) return
    reset()
    host = event.currentTarget as HTMLElement
    release = listenMotionChanges(() => { if (document.hidden || prefersReducedMotion()) reset() })
    document.addEventListener('keydown', reset, true)
    document.addEventListener('scroll', reset, true)
    window.addEventListener('resize', reset)
    move(event)
  }
  onDeactivated(reset)
  onScopeDispose(reset)
  return { enter, move, reset }
}
