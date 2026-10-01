import { nextTick, onBeforeUnmount, onMounted, watch, type Ref } from 'vue'
import { useEventListener } from '@vueuse/core'
import { useVisualActivity } from '@/composables/useVisualActivity'
import type { ArtworkRecord } from '@/types/artwork'

type Dissolve = typeof import('@/utils/canvasDissolve')['startCanvasDissolve']
const MAX_DUST_CARDS = 2
const MAX_MOVING_CARDS = 24

/** Deletion stays repository-owned; this callback only runs after confirmed success. */
export function useGalleryDeleteMotion(
  root: Ref<HTMLElement | null>, items: () => ArtworkRecord[], loading: () => boolean,
) {
  const { canAnimate, lowEffects } = useVisualActivity(root)
  let dissolve: Dissolve | null = null
  let revision = 0
  const dust = new Map<string, { stop: () => void; timer: ReturnType<typeof setTimeout> }>()
  const moves = new Set<Animation>()
  let positions = new Map<string, DOMRect>()
  let positionTimer: ReturnType<typeof setTimeout> | undefined
  function stopDust(id: string) {
    const active = dust.get(id)
    if (!active) return
    clearTimeout(active.timer); active.stop(); dust.delete(id)
  }
  function stop() {
    revision++
    for (const id of dust.keys()) stopDust(id)
    for (const animation of moves) animation.cancel()
    moves.clear(); positions.clear(); clearTimeout(positionTimer)
  }
  onMounted(() => {
    void import('@/utils/canvasDissolve').then(module => { dissolve = module.startCanvasDissolve }).catch(() => {})
  })
  function visibleRect(element: HTMLElement) {
    const rect = element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight
      && rect.right > 0 && rect.left < window.innerWidth ? rect : null
  }
  function onDeleted(ids: Array<string | number>) {
    stop()
    const host = root.value
    if (!host || !canAnimate.value || lowEffects.value) return
    const deleted = new Set(ids.map(String))
    // The wall uses greedy masonry columns, not a TransitionGroup. Capture only
    // visible survivors and animate their transform after Vue settles the new columns.
    for (const card of host.querySelectorAll<HTMLElement>('.artwork[data-card-id]')) {
      const id = card.dataset.cardId!, rect = visibleRect(card)
      if (!rect) continue
      if (!deleted.has(id)) {
        if (positions.size < MAX_MOVING_CARDS) positions.set(id, rect)
        continue
      }
      if (!dissolve || dust.size >= MAX_DUST_CARDS) continue
      const image = card.querySelector<HTMLImageElement>('img.artwork-image-hd.is-loaded')
        ?? card.querySelector<HTMLImageElement>('img.artwork-image:not(.artwork-image-hd)')
      if (!image?.complete || !image.naturalWidth) continue
      // Two compact effects total <=2400 grains and <=1.2MP of retained canvas buffers.
      // Reuse decoded displayed images only; never fetch original artwork for motion.
      const release = dissolve(image, host, 'thumbnail')
      if (!release) continue
      dust.set(id, { stop: release, timer: setTimeout(() => stopDust(id), 800) })
    }
    positionTimer = setTimeout(() => positions.clear(), 800)
    const token = revision
    void nextTick(() => { if (token === revision) settle() })
  }
  function settle() {
    if (loading() || !positions.size || !root.value || !canAnimate.value || lowEffects.value) return
    const previous = positions; positions = new Map(); clearTimeout(positionTimer)
    for (const card of root.value.querySelectorAll<HTMLElement>('.artwork[data-card-id]')) {
      const before = previous.get(card.dataset.cardId!), after = before && visibleRect(card)
      if (!before || !after || Math.abs(before.width - after.width) > 1 || typeof card.animate !== 'function') continue
      const x = before.left - after.left, y = before.top - after.top
      if (Math.abs(x) + Math.abs(y) < 1) continue
      try {
        const animation = card.animate([{ transform: `translate(${x}px, ${y}px)` }, { transform: 'translate(0, 0)' }],
          { duration: 240, easing: 'cubic-bezier(.2,.65,.3,1)' })
        moves.add(animation)
        const release = () => { moves.delete(animation); animation.cancel() }
        void animation.finished.then(release, release)
      } catch { /* Instant masonry layout remains correct without animation support. */ }
    }
  }
  watch([() => items().map(item => item.id), loading], () => {
    // Restoring/reintroducing an ID ends its stale deletion visual immediately.
    for (const item of items()) stopDust(String(item.id))
    settle()
  }, { flush: 'post' })
  watch([canAnimate, lowEffects], () => { if (!canAnimate.value || lowEffects.value) stop() }, { flush: 'sync' })
  useEventListener(root, 'pointerdown', stop, { passive: true })
  useEventListener(window, 'scroll', stop, { passive: true, capture: true })
  useEventListener(window, 'resize', stop, { passive: true })
  onBeforeUnmount(stop)
  // Bind success feedback to the interaction that requested deletion. Leaving,
  // scrolling or another interaction invalidates it even if storage finishes later.
  function forAction() {
    const token = revision
    return (ids: Array<string | number>) => { if (token === revision) onDeleted(ids) }
  }
  return { onDeleted, forAction, stop }
}
