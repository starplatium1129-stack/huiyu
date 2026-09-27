import { computed, nextTick, ref, watch, type Ref } from 'vue'
import { useWindowSize } from '@vueuse/core'

/** Geometry belongs to the menu, never to the Live2D framing or native window. */
export function useCompanionOrbit(open: () => boolean, root: Ref<HTMLElement | null>, close: () => void) {
  const { width, height } = useWindowSize()
  const compact = computed(() => width.value < 460 || height.value < 580)
  const size = computed(() => Math.max(180, Math.min(width.value - 24, height.value - 112, 440)))
  const category = ref<'characters' | 'motions' | 'expressions' | null>(null)
  const page = ref(0)
  let returnFocus: HTMLElement | null = null
  watch(open, async value => {
    category.value = null; page.value = 0
    if (value) {
      returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
      await nextTick()
      if (open()) root.value?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })
    } else if (root.value?.contains(document.activeElement)) {
      if (returnFocus?.isConnected && !root.value.contains(returnFocus)) returnFocus.focus({ preventScroll: true })
      else document.querySelector<HTMLElement>('.companion-page')?.focus({ preventScroll: true })
    }
  }, { flush: 'sync' })
  watch(category, async (value, previous) => {
    page.value = 0
    await nextTick()
    if (!open() || category.value !== value) return
    if (value && compact.value) root.value?.querySelector<HTMLButtonElement>('.orbit-selection button')?.focus({ preventScroll: true })
    else if (!value && previous) root.value?.querySelector<HTMLButtonElement>(`[data-category-button="${previous}"]`)?.focus({ preventScroll: true })
  })
  function key(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation()
      if (category.value) category.value = null
      else close()
      return
    }
    if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End', 'Tab'].includes(event.key)) return
    const buttons = [...(root.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [])].filter(el => el.getClientRects().length)
    if (!buttons.length) return
    event.preventDefault(); event.stopPropagation()
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const backward = event.key === 'ArrowLeft' || event.key === 'ArrowUp' || event.key === 'Tab' && event.shiftKey
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (backward ? -1 : 1) + buttons.length) % buttons.length
    buttons[index]?.focus({ preventScroll: true })
  }
  return { compact, size, category, page, key }
}

export function orbitPoint(angle: number, radius: number) {
  const radians = angle * Math.PI / 180
  return { x: 220 + Math.cos(radians) * radius, y: 220 + Math.sin(radians) * radius }
}

/** A 60° opening above the character keeps tall models' faces clear. */
export function orbitAngle(index: number) { return -41.25 + index * 37.5 }

/** Rounded annular sectors; a fixed viewBox makes all eight targets scale together. */
export function orbitSector(index: number) {
  const angle = orbitAngle(index), start = angle - 16.5, end = angle + 16.5
  const outerStart = orbitPoint(start + 2, 162), outerEnd = orbitPoint(end - 2, 162)
  const cornerA = orbitPoint(end, 162), edgeA = orbitPoint(end, 155)
  const edgeB = orbitPoint(end, 99), cornerB = orbitPoint(end, 92), innerEnd = orbitPoint(end - 4, 92)
  const innerStart = orbitPoint(start + 4, 92), cornerC = orbitPoint(start, 92), edgeC = orbitPoint(start, 99)
  const edgeD = orbitPoint(start, 155), cornerD = orbitPoint(start, 162)
  const p = (point: { x: number; y: number }) => `${point.x.toFixed(2)} ${point.y.toFixed(2)}`
  return `M ${p(outerStart)} A 162 162 0 0 1 ${p(outerEnd)} Q ${p(cornerA)} ${p(edgeA)} L ${p(edgeB)} Q ${p(cornerB)} ${p(innerEnd)} A 92 92 0 0 0 ${p(innerStart)} Q ${p(cornerC)} ${p(edgeC)} L ${p(edgeD)} Q ${p(cornerD)} ${p(outerStart)} Z`
}
