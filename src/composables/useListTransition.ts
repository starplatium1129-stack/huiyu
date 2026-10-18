// Inspira UI AnimatedList pattern, adapted to finite, record-keyed collections.
// https://github.com/unovue/inspira-ui/blob/04c57ab62b9713872ebbf68988dff1836ed3d764/app/components/inspira/ui/animated-list/AnimatedList.vue
// MIT Copyright (c) 2024-2026 rahulv.dev; notice: assets/licenses/inspira-ui.txt.
import { onActivated, onDeactivated, onMounted, onScopeDispose, watch, type Ref } from 'vue'
import { listenMotionChanges, prefersReducedMotion } from '@/utils/motionPreference'
import { createContentSpring, type ContentSpring, type SpringPresentation } from '@/utils/contentSpring'

const MAX_MEASURED = 64
const MAX_ANIMATED = 20
const MAX_ENTERING = 8
type Position = { element: HTMLElement; rect: DOMRect; state?: SpringPresentation }
type Snapshot = { root: HTMLElement; ids: Set<string>; positions: Map<string, Position> }

/** Retained cards move; only newly visible records enter. Initial routes own their reveal. */
export function useListTransition(root: Ref<HTMLElement | null>, ids: () => readonly string[]) {
  const animations = new Map<HTMLElement, ContentSpring>()
  let snapshot: Snapshot | null = null
  let active = false
  let release: (() => void) | undefined
  function cancelAnimations() {
    for (const animation of animations.values()) {
      animation.cancel()
    }
    animations.clear()
  }
  function clear() { snapshot = null; cancelAnimations() }
  function preference() { if (document.hidden || prefersReducedMotion()) clear() }
  function start() {
    if (active) return
    active = true
    release = listenMotionChanges(preference)
  }
  function stop() {
    active = false; clear(); release?.(); release = undefined
  }
  onMounted(start)
  onActivated(start)
  onDeactivated(stop)
  onScopeDispose(stop)

  function canAnimate() {
    return active && !document.hidden && !prefersReducedMotion()
      && root.value?.isConnected && !root.value.closest('[inert], [hidden], [data-route-entering="true"]')
  }
  function visibleCards(element: HTMLElement) {
    const cards: Array<{ element: HTMLElement; id: string; rect: DOMRect }> = []
    for (const card of Array.from(element.children).slice(0, MAX_MEASURED)) {
      if (!(card instanceof HTMLElement) || !card.dataset.listKey) continue
      // The existing image-ready reveal retains ownership of undecoded previews.
      if (card.hasAttribute('data-reveal') && !card.hasAttribute('data-revealed')) continue
      const rect = card.getBoundingClientRect()
      if (!rect.width || !rect.height || rect.bottom <= 0 || rect.top >= innerHeight || rect.right <= 0 || rect.left >= innerWidth) continue
      cards.push({ element: card, id: card.dataset.listKey, rect })
      if (cards.length === MAX_ANIMATED) break
    }
    return cards
  }
  function move(element: HTMLElement, values: number[], transform = '', velocities?: number[]) {
    const animation = createContentSpring(element, values,
      ([x, y, opacity]) => ({ transform: `translate(${x}px, ${y}px)${transform}`, opacity }), { velocities, opacity: 2 })
    animations.set(element, animation)
    animation.to([0, 0, 1], () => {
      if (animations.get(element) !== animation) return
      animations.delete(element); animation.cancel()
    })
  }

  watch(ids, (next, previous) => {
    snapshot = null
    if (next.length === previous.length && next.every((id, index) => id === previous[index])) return
    const element = root.value
    if (!element || !canAnimate()) { cancelAnimations(); return }
    const positions = new Map<string, Position>()
    // Read all presentation positions before cancelling or changing any effect.
    for (const card of visibleCards(element)) positions.set(card.id, {
      element: card.element, rect: card.rect,
      state: animations.get(card.element)?.capture(),
    })
    cancelAnimations()
    snapshot = { root: element, ids: new Set(previous), positions }
  }, { flush: 'pre' })

  watch(ids, () => {
    const before = snapshot; snapshot = null
    if (!before || before.root !== root.value || !canAnimate()) return
    let entering = 0
    // Batch geometry/style reads before starting native compositor timelines.
    const changes = visibleCards(before.root).flatMap(card => {
      const old = before.positions.get(card.id)
      const fresh = !before.ids.has(card.id)
      if (!old && entering >= MAX_ENTERING) return []
      const x = old?.element === card.element ? old.rect.left - card.rect.left : 0
      const y = old?.element === card.element ? old.rect.top - card.rect.top : 12
      const opacity = old?.state?.values[2] ?? (fresh ? .8 : 1)
      const velocities = old?.state?.velocities ?? [0, 0, 0]
      if (Math.abs(x) < .5 && Math.abs(y) < .5 && opacity >= 1 && velocities.every(value => Math.abs(value) < .01)) return []
      const computed = getComputedStyle(card.element)
      const transform = computed.transform === 'none' ? '' : ` ${computed.transform}`
      if (!old) entering++
      return [{ element: card.element, x, y, opacity, transform, velocities }]
    })
    for (const change of changes) {
      move(change.element, [change.x, change.y, change.opacity], change.transform, change.velocities)
    }
  }, { flush: 'post' })
  watch(root, element => {
    clear()
    // Returning from an empty result mounts a new grid, with no old DOM to FLIP.
    if (!element || !canAnimate()) return
    const cards = visibleCards(element).slice(0, MAX_ENTERING).map(card => {
      const transform = getComputedStyle(card.element).transform
      return { element: card.element, transform: transform === 'none' ? '' : ` ${transform}` }
    })
    for (const card of cards) move(card.element, [0, 12, .8], card.transform)
  }, { flush: 'post' })
}
