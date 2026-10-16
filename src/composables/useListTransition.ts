// Inspira UI AnimatedList pattern, adapted to finite, record-keyed collections.
// https://github.com/unovue/inspira-ui/blob/04c57ab62b9713872ebbf68988dff1836ed3d764/app/components/inspira/ui/animated-list/AnimatedList.vue
// MIT Copyright (c) 2024-2026 rahulv.dev; notice: assets/licenses/inspira-ui.txt.
import { onActivated, onDeactivated, onMounted, onScopeDispose, watch, type Ref } from 'vue'
import { listenMotionChanges, prefersReducedMotion } from '@/utils/motionPreference'
import { cssTimeToMilliseconds } from '@/utils/motionTiming'

const MAX_MEASURED = 64
const MAX_ANIMATED = 20
const MAX_ENTERING = 8
type Position = { element: HTMLElement; rect: DOMRect; opacity?: string }
type Snapshot = { root: HTMLElement; ids: Set<string>; positions: Map<string, Position> }

/** Retained cards move; only newly visible records enter. Initial routes own their reveal. */
export function useListTransition(root: Ref<HTMLElement | null>, ids: () => readonly string[]) {
  const animations = new Map<HTMLElement, Animation>()
  let snapshot: Snapshot | null = null
  let active = false, keyboard = false
  let release: (() => void) | undefined
  function cancelAnimations() {
    for (const animation of animations.values()) {
      animation.onfinish = animation.oncancel = null
      animation.cancel()
    }
    animations.clear()
  }
  function clear() { snapshot = null; cancelAnimations() }
  function keyboardInput() { keyboard = true; clear() }
  function pointerInput() { keyboard = false }
  function preference() { if (document.hidden || prefersReducedMotion()) clear() }
  function start() {
    if (active) return
    active = true; keyboard = false
    document.addEventListener('keydown', keyboardInput, true)
    document.addEventListener('pointerdown', pointerInput, true)
    release = listenMotionChanges(preference)
  }
  function stop() {
    active = false; clear(); release?.(); release = undefined
    document.removeEventListener('keydown', keyboardInput, true)
    document.removeEventListener('pointerdown', pointerInput, true)
  }
  onMounted(start)
  onActivated(start)
  onDeactivated(stop)
  onScopeDispose(stop)

  function canAnimate() {
    return active && !keyboard && !document.hidden && !prefersReducedMotion()
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

  watch(ids, (next, previous) => {
    snapshot = null
    if (next.length === previous.length && next.every((id, index) => id === previous[index])) return
    const element = root.value
    if (!element || !canAnimate()) { cancelAnimations(); return }
    const positions = new Map<string, Position>()
    // Read all presentation positions before cancelling or changing any effect.
    for (const card of visibleCards(element)) positions.set(card.id, {
      element: card.element, rect: card.rect,
      opacity: animations.has(card.element) ? getComputedStyle(card.element).opacity : undefined,
    })
    cancelAnimations()
    snapshot = { root: element, ids: new Set(previous), positions }
  }, { flush: 'pre' })

  watch(ids, () => {
    const before = snapshot; snapshot = null
    if (!before || before.root !== root.value || !canAnimate()) return
    const style = getComputedStyle(before.root)
    const duration = cssTimeToMilliseconds(style.getPropertyValue('--motion-control'))
    let entering = 0
    // Batch geometry/style reads before starting native compositor timelines.
    const changes = visibleCards(before.root).flatMap(card => {
      const old = before.positions.get(card.id)
      const fresh = !before.ids.has(card.id)
      if (!old && (!fresh || entering >= MAX_ENTERING)) return []
      const x = old?.element === card.element ? old.rect.left - card.rect.left : 0
      const y = old?.element === card.element ? old.rect.top - card.rect.top : 6
      const opacity = old?.opacity ?? (fresh ? '.6' : '1')
      if (Math.abs(x) < .5 && Math.abs(y) < .5 && Number(opacity) >= 1) return []
      const computed = getComputedStyle(card.element)
      const transform = computed.transform === 'none' ? '' : ` ${computed.transform}`
      const delay = fresh ? Math.min(entering++ * 16, duration / 4) : 0
      return [{ element: card.element, x, y, opacity, transform, delay }]
    })
    for (const change of changes) {
      if (typeof change.element.animate !== 'function') continue
      const animation = change.element.animate([
        { transform: `translate(${change.x}px, ${change.y}px)${change.transform}`, opacity: change.opacity },
        { transform: `translate(0px, 0px)${change.transform}`, opacity: 1 },
      ], { duration, delay: change.delay, easing: style.getPropertyValue('--ease-out').trim(), fill: 'both' })
      animations.set(change.element, animation)
      animation.onfinish = animation.oncancel = () => {
        if (animations.get(change.element) !== animation) return
        animations.delete(change.element)
        animation.onfinish = animation.oncancel = null
        animation.cancel()
      }
    }
  }, { flush: 'post' })
  watch(root, clear, { flush: 'sync' })
}
