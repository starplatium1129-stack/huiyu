import { nextTick, onBeforeUnmount, onMounted, watch, type Ref } from 'vue'
import { useEventListener } from '@vueuse/core'
import { useVisualActivity } from '@/composables/useVisualActivity'
import type { ArtworkRecord } from '@/types/artwork'
import { createContentSpring, type ContentSpring, type SpringPresentation } from '@/utils/contentSpring'

type Dissolve = typeof import('@/utils/canvasDissolve')['startCanvasDissolve']
const MAX_DUST_CARDS = 2
const MAX_MOVING_CARDS = 24
const MAX_MEASURED_CARDS = 80

/** One owner for filtered masonry and confirmed deletion; records stay repository-owned. */
export function useGalleryListMotion(
  root: Ref<HTMLElement | null>, items: () => ArtworkRecord[], loading: () => boolean,
) {
  const { canAnimate, lowEffects } = useVisualActivity(root)
  let dissolve: Dissolve | null = null
  let revision = 0
  const dust = new Map<string, { stop: () => void; timer: ReturnType<typeof setTimeout> }>()
  const moves = new Map<HTMLElement, ContentSpring>()
  let surface: ContentSpring | null = null
  let handoff: HTMLElement | null = null
  let positions = new Map<string, { rect: DOMRect; state?: SpringPresentation }>()
  let previousIds = new Set<string>()
  let listChanged = false
  let positionTimer: ReturnType<typeof setTimeout> | undefined
  function stopDust(id: string) {
    const active = dust.get(id)
    if (!active) return
    clearTimeout(active.timer); active.stop(); dust.delete(id)
  }
  function finishHandoff() {
    if (moves.size || surface || positions.size || listChanged) return
    handoff?.removeAttribute('data-list-motion'); handoff = null
  }
  function beginHandoff() {
    const wall = root.value?.querySelector<HTMLElement>('.gallery-wall') ?? null
    if (handoff !== wall) handoff?.removeAttribute('data-list-motion')
    handoff = wall; handoff?.setAttribute('data-list-motion', '')
  }
  function stop() {
    revision++
    for (const id of dust.keys()) stopDust(id)
    for (const animation of moves.values()) animation.cancel()
    surface?.cancel(); surface = null
    moves.clear(); positions.clear(); previousIds.clear(); listChanged = false; clearTimeout(positionTimer)
    finishHandoff()
  }
  onMounted(() => {
    void import('@/utils/canvasDissolve').then(module => { dissolve = module.startCanvasDissolve }).catch(() => {})
  })
  function visibleRect(element: HTMLElement) {
    const rect = element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight
      && rect.right > 0 && rect.left < window.innerWidth ? rect : null
  }
  function cards() {
    return Array.from(root.value?.querySelectorAll<HTMLElement>('.artwork[data-card-id]') ?? []).slice(0, MAX_MEASURED_CARDS)
  }
  function capture(exclude = new Set<string>()) {
    for (const card of cards()) {
      const id = card.dataset.cardId!, rect = visibleRect(card)
      if (rect && !exclude.has(id)) positions.set(id, { rect, state: moves.get(card)?.capture() })
      if (positions.size === MAX_MOVING_CARDS) break
    }
  }
  function onDeleted(ids: Array<string | number>) {
    revision++
    for (const id of dust.keys()) stopDust(id)
    positions.clear(); clearTimeout(positionTimer)
    listChanged = false
    const host = root.value
    if (!host || !canAnimate.value || lowEffects.value) return
    listChanged = true
    const deleted = new Set(ids.map(String))
    // The wall uses greedy masonry columns, not a TransitionGroup. Capture only
    // visible survivors and animate their transform after Vue settles the new columns.
    capture(deleted)
    beginHandoff()
    previousIds = new Set(items().map(item => String(item.id)))
    for (const card of cards()) {
      const id = card.dataset.cardId!, rect = visibleRect(card)
      if (!rect) continue
      if (!deleted.has(id)) continue
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
    positionTimer = setTimeout(() => { positions.clear(); listChanged = false; finishHandoff() }, 800)
    const token = revision
    void nextTick(() => { if (token === revision) settle() })
  }
  function settle() {
    if (loading() || !root.value || !canAnimate.value || lowEffects.value || !positions.size && !listChanged) return
    const previous = positions; positions = new Map(); clearTimeout(positionTimer)
    beginHandoff()
    // Read every visible destination and live transform before cancelling or writing.
    const visible: HTMLElement[] = []
    const targets: Array<{ card: HTMLElement; x: number; y: number; state?: SpringPresentation }> = []
    for (const card of cards()) {
      const before = previous.get(card.dataset.cardId!), after = visibleRect(card)
      if (!after || typeof card.animate !== 'function') continue
      visible.push(card)
      if (!before) {
        if (listChanged && !previousIds.has(card.dataset.cardId!) && targets.length < MAX_MOVING_CARDS) targets.push({ card, x: 0, y: 10 })
        continue
      }
      if (Math.abs(before.rect.width - after.width) > 1) continue
      const live = moves.get(card)?.capture()
      const x = before.rect.left - after.left + (live?.values[0] ?? 0), y = before.rect.top - after.top + (live?.values[1] ?? 0)
      if (Math.abs(x) + Math.abs(y) >= .5 || before.state) targets.push({ card, x, y, state: before.state ?? { values: [0, 0, 1], velocities: [0, 0, 0] } })
    }
    const wall = root.value.querySelector<HTMLElement>('.gallery-wall')
    const wallState = surface?.capture()
    for (const animation of moves.values()) animation.cancel()
    moves.clear(); surface?.cancel(); surface = null
    // Remounted survivors keep their already visible state; the wall owns this change.
    for (const card of visible) card.setAttribute('data-revealed', '')
    // No visible cards to move: a quiet handoff also covers filtered empty states.
    if (listChanged && !targets.length) {
      if (wall && typeof wall.animate === 'function') {
        const animation = createContentSpring(wall, wallState?.values ?? [.96], ([opacity]) => ({ opacity }), { velocities: wallState?.velocities, opacity: 0 })
        surface = animation
        const release = () => { if (surface === animation) surface = null; animation.cancel(); finishHandoff() }
        animation.to([1], release)
      }
    } else for (const { card, x, y, state } of targets.slice(0, MAX_MOVING_CARDS)) {
      try {
        const animation = createContentSpring(card, [x, y, state?.values[2] ?? .8],
          ([x, y, opacity]) => ({ transform: `translate(${x}px, ${y}px)`, opacity }), { velocities: state?.velocities, opacity: 2 })
        moves.set(card, animation)
        const release = () => { if (moves.get(card) === animation) moves.delete(card); animation.cancel(); finishHandoff() }
        animation.to([0, 0, 1], release)
      } catch { /* Instant masonry layout remains correct without animation support. */ }
    }
    listChanged = false; previousIds.clear()
    finishHandoff()
  }
  const ids = () => items().map(item => String(item.id))
  watch(ids, (next, previous) => {
    // Appending a page retains placement; decoding thumbnails never changes IDs.
    if (next.length === previous.length && previous.every((id, index) => next[index] === id)) return
    if (previous.length && next.length > previous.length && previous.every((id, index) => next[index] === id)) return
    if (loading() || !canAnimate.value || lowEffects.value || root.value?.closest('[inert], [hidden]')) return
    if (!previous.length && root.value?.dataset.routeEntering === 'true') return
    previousIds = new Set(previous); listChanged = true
    if (!positions.size) capture()
    beginHandoff()
  }, { flush: 'pre' })
  watch([ids, loading], () => {
    // Restoring/reintroducing an ID ends its stale deletion visual immediately.
    for (const item of items()) stopDust(String(item.id))
    settle()
  }, { flush: 'post' })
  watch([canAnimate, lowEffects], () => { if (!canAnimate.value || lowEffects.value) stop() }, { flush: 'sync' })
  // A new action invalidates delayed deletion feedback, while retained cards keep
  // their current position/velocity for the next filter's layout.
  function interact() { revision++; for (const id of dust.keys()) stopDust(id) }
  useEventListener(root, 'pointerdown', interact, { passive: true })
  useEventListener(root, 'keydown', interact)
  // Album navigation restores scroll/focus in the same frame as its arrival.
  useEventListener(window, 'scroll', stop, { passive: true, capture: true })
  useEventListener(root, 'wheel', stop, { passive: true })
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
