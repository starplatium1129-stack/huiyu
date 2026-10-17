import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch, type Ref } from 'vue'
import { useEventListener } from '@vueuse/core'
import { profileLocalStorage } from '@/platform/web/profileStorage'
import { DIRECTOR_LAYOUT_KEY } from '@/utils/storageKeys'

type Side = 'materials' | 'inspector'
interface LayoutPreference { materials: number | null; inspector: number | null; hideMaterials: boolean; hideInspector: boolean }
const defaults = (): LayoutPreference => ({ materials: null, inspector: null, hideMaterials: false, hideInspector: false })
// Match the gallery's horizontal intent tolerance, within the 16 CSS px resize hit area.
const RESIZE_INTENT_PX = 6
function parseDirectorLayout(raw: string | null): LayoutPreference {
  try {
    const value: unknown = JSON.parse(raw || 'null')
    if (!value || typeof value !== 'object') return defaults()
    const item = value as Record<string, unknown>
    const width = (key: Side) => typeof item[key] === 'number' && Number.isFinite(item[key]) ? Math.max(240, Math.min(560, item[key])) : null
    return { materials: width('materials'), inspector: width('inspector'), hideMaterials: item.hideMaterials === true, hideInspector: item.hideInspector === true }
  } catch { return defaults() }
}

function readPreferences() { return parseDirectorLayout(profileLocalStorage.getItem(DIRECTOR_LAYOUT_KEY)) }

/** Remember rail preferences; actual widths always fit the current CSS viewport. */
export function useDirectorLayout(root: Ref<HTMLElement | null>) {
  const preferences = ref(readPreferences())
  const width = ref(960), viewport = ref(window.innerWidth), dragging = ref<Side | null>(null)
  // Collapse only when the measured workspace cannot fit both rails and a useful canvas.
  // Hiding the inspector leaves enough space for materials beside the canvas.
  const compact = computed(() => viewport.value >= 1024 && width.value < 1120 && !preferences.value.hideInspector)
  const compactMaterialsOpen = ref(false)
  watch(compact, async () => {
    // Capture ownership before Vue hides a rail; only that rail may hand off focus.
    const materials = root.value?.querySelector<HTMLElement>('#drawing-materials')
    const active = document.activeElement
    const ownedFocus = active instanceof HTMLElement && materials?.contains(active)
    compactMaterialsOpen.value = false
    if (!ownedFocus) return
    await nextTick()
    if (!observing || !materials?.isConnected || materials.getClientRects().length) return
    const current = document.activeElement
    if (current !== active && current !== document.body) return
    const toggle = root.value?.closest('.pb')?.querySelector<HTMLButtonElement>('#director-materials-toggle')
    if (toggle?.getClientRects().length) toggle.focus({ preventScroll: true })
  })
  let observer: ResizeObserver | null = null
  let observing = false
  const scrollPositions = new Map<HTMLElement, { left: number; top: number }>()
  // KeepAlive retains the rails, but detaching their DOM can clamp scrollTop.
  // Remember real active scrolls before detachment; hidden layout changes do not
  // replace the reading position, and restoration never animates or delays input.
  useEventListener(root, 'scroll', event => {
    const surface = event.target
    if (observing && surface instanceof HTMLElement) {
      scrollPositions.set(surface, { left: surface.scrollLeft, top: surface.scrollTop })
    }
  }, { capture: true })
  let activePointer: { element: HTMLElement; id: number; side: Side; x: number; width: number; before: LayoutPreference; materialsOpen: boolean } | null = null
  let suppressClick = false, suppressDoubleClick = false
  const preferredInspectorWidth = computed(() => preferences.value.inspector ?? (viewport.value <= 1440 ? 320 : 368))
  // Resizing may use spare canvas width, including a compact portrait workspace.
  const available = computed(() => Math.max(0, width.value - 440 - 48))
  const materialsWidth = computed(() => Math.max(240, Math.min(preferences.value.materials ?? (viewport.value <= 1440 ? 300 : 336),
    available.value - (preferences.value.hideInspector ? 0 : Math.min(preferredInspectorWidth.value, Math.max(280, available.value - 240))))))
  const inspectorWidth = computed(() => compact.value ? 320 : Math.max(280, Math.min(preferredInspectorWidth.value,
    available.value - (preferences.value.hideMaterials ? 0 : materialsWidth.value))))
  // Theme navigation and page framing reduce the actual workspace even before
  // a user resizes either rail. Clamp defaults too, without rewriting preferences.
  const style = computed(() => ({ '--director-material-width': `${materialsWidth.value}px`, '--director-inspector-width': `${inspectorWidth.value}px` }))
  const collapsed = computed(() => ({ materials: compact.value ? !compactMaterialsOpen.value : preferences.value.hideMaterials, inspector: preferences.value.hideInspector }))
  function save() {
    try { profileLocalStorage.setItem(DIRECTOR_LAYOUT_KEY, JSON.stringify(preferences.value)) } catch { /* The current layout remains usable if storage is unavailable. */ }
  }
  function measure() {
    if (!observing || !root.value?.isConnected) return
    width.value = root.value.clientWidth || 960; viewport.value = window.innerWidth
  }
  function setWidth(side: Side, value: number) {
    const otherSide = side === 'materials' ? 'inspector' : 'materials'
    const other = collapsed.value[otherSide] ? 0 : currentWidth(otherSide)
    preferences.value[side] = Math.round(Math.max(side === 'materials' ? 240 : 280, Math.min(value, 560, available.value - other)))
  }
  function finish(event?: PointerEvent) {
    const active = activePointer
    if (!active || (event && active.id !== event.pointerId)) return
    const commit = event?.type === 'pointerup'
    const resized = dragging.value !== null
    activePointer = null; dragging.value = null
    suppressClick = resized || !commit
    if (!commit) {
      preferences.value = active.before
      compactMaterialsOpen.value = active.materialsOpen
    }
    if (active.element.hasPointerCapture(active.id)) active.element.releasePointerCapture(active.id)
    if (commit && resized) save()
  }
  function escapeResize(event: KeyboardEvent) {
    if (!activePointer || event.key !== 'Escape' || event.isComposing || event.keyCode === 229) return
    event.preventDefault(); event.stopImmediatePropagation()
    finish()
  }
  function click(event: MouseEvent) {
    if (event.detail === 0) return
    // A drag can be either click in a native double-click sequence.
    suppressDoubleClick = suppressClick || (event.detail > 1 && suppressDoubleClick)
    if (suppressClick) { event.preventDefault(); event.stopPropagation() }
  }
  function currentWidth(side: Side) { return side === 'materials' ? materialsWidth.value : inspectorWidth.value }
  function start(side: Side, event: PointerEvent) {
    if (!observing || activePointer || event.button !== 0 || !event.isPrimary) return
    measure()
    const element = event.currentTarget as HTMLElement
    activePointer = { element, id: event.pointerId, side, x: event.clientX, width: currentWidth(side), before: { ...preferences.value }, materialsOpen: compactMaterialsOpen.value }
    suppressClick = false
    element.setPointerCapture(event.pointerId)
    element.focus({ preventScroll: true })
    event.preventDefault()
  }
  function move(event: PointerEvent) {
    const active = activePointer
    if (!active || active.id !== event.pointerId) return
    const distance = event.clientX - active.x
    if (!dragging.value && Math.abs(distance) < RESIZE_INTENT_PX) return
    dragging.value = active.side
    setWidth(active.side, active.width + distance * (active.side === 'materials' ? 1 : -1))
  }
  function key(side: Side, event: KeyboardEvent) {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    finish()
    const step = event.shiftKey ? 40 : 10
    const current = currentWidth(side)
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      const sign = event.key === 'ArrowRight' ? 1 : -1
      setWidth(side, current + sign * step * (side === 'materials' ? 1 : -1))
    } else if (event.key === 'Home') setWidth(side, side === 'materials' ? 240 : 280)
    else if (event.key === 'End') setWidth(side, 560)
    else return
    event.preventDefault(); save()
  }
  function toggle(side: Side) {
    finish()
    if (compact.value && side === 'materials') { compactMaterialsOpen.value = !compactMaterialsOpen.value; return }
    const key = side === 'materials' ? 'hideMaterials' : 'hideInspector'
    preferences.value[key] = !preferences.value[key]; save()
  }
  function show(side: Side) { if (collapsed.value[side]) toggle(side) }
  function reset(event?: MouseEvent) {
    if (event && suppressDoubleClick) { event.preventDefault(); event.stopPropagation(); return }
    finish(); compactMaterialsOpen.value = false; preferences.value = defaults(); save()
  }
  function changed(event: StorageEvent) { if (observing && event.key === DIRECTOR_LAYOUT_KEY && !activePointer) preferences.value = readPreferences() }
  useEventListener(window, 'resize', measure)
  useEventListener(window, 'storage', changed)
  useEventListener(window, 'keydown', escapeResize, { capture: true })
  useEventListener(window, 'blur', () => finish())
  function observe() {
    if (observing) return
    observing = true
    preferences.value = readPreferences()
    observer ??= new ResizeObserver(measure)
    if (root.value) observer.observe(root.value)
    measure()
  }
  function stopObserving() {
    observing = false
    finish()
    suppressClick = suppressDoubleClick = false
    observer?.disconnect()
  }
  watch(root, () => {
    observer?.disconnect()
    if (!observing) return
    if (root.value) observer?.observe(root.value)
    measure()
  })
  onMounted(observe)
  onActivated(() => {
    observe()
    for (const [surface, position] of scrollPositions) {
      if (!root.value?.contains(surface)) { scrollPositions.delete(surface); continue }
      surface.scrollLeft = position.left
      surface.scrollTop = position.top
    }
  })
  onDeactivated(stopObserving)
  onBeforeUnmount(() => { stopObserving(); scrollPositions.clear() })
  return { style, collapsed, compact, dragging, desktop: computed(() => viewport.value >= 1024), materialsWidth, inspectorWidth, start, move, finish, click, key, toggle, show, reset }
}
