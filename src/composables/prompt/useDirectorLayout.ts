import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch, type Ref } from 'vue'
import { profileLocalStorage } from '@/platform/web/profileStorage'
import { DIRECTOR_LAYOUT_KEY } from '@/utils/storageKeys'

type Side = 'materials' | 'inspector'
interface LayoutPreference { materials: number | null; inspector: number | null; hideMaterials: boolean; hideInspector: boolean }
const defaults = (): LayoutPreference => ({ materials: null, inspector: null, hideMaterials: false, hideInspector: false })
export function parseDirectorLayout(raw: string | null): LayoutPreference {
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
  const width = ref(960), viewport = ref(1280), rootFont = ref(16), dragging = ref<Side | null>(null)
  let observer: ResizeObserver | null = null
  let observing = false
  let activePointer: { element: HTMLElement; id: number; side: Side; x: number; width: number } | null = null
  const baseMaterials = computed(() => Math.max(260, Math.min(21 * rootFont.value, viewport.value * .15)))
  const baseInspector = computed(() => Math.max(300, Math.min(24 * rootFont.value, viewport.value * .22)))
  // Resizing may use spare canvas width, including a compact portrait workspace.
  const available = computed(() => Math.max(0, width.value - 320 - 32))
  const materialsWidth = computed(() => Math.max(240, Math.min(preferences.value.materials ?? baseMaterials.value,
    available.value - (preferences.value.hideInspector ? 0 : Math.min(preferences.value.inspector ?? baseInspector.value, Math.max(280, available.value - 240))))))
  const inspectorWidth = computed(() => Math.max(280, Math.min(preferences.value.inspector ?? baseInspector.value,
    available.value - (preferences.value.hideMaterials ? 0 : materialsWidth.value))))
  const style = computed(() => preferences.value.materials !== null || preferences.value.inspector !== null
    ? { '--director-material-width': `${materialsWidth.value}px`, '--director-inspector-width': `${inspectorWidth.value}px` } : {})
  const collapsed = computed(() => ({ materials: preferences.value.hideMaterials, inspector: preferences.value.hideInspector }))
  function save() {
    try { profileLocalStorage.setItem(DIRECTOR_LAYOUT_KEY, JSON.stringify(preferences.value)) } catch { /* The current layout remains usable if storage is unavailable. */ }
  }
  function measure() {
    if (!observing || !root.value?.isConnected) return
    width.value = root.value?.clientWidth || 960; viewport.value = typeof innerWidth === 'number' ? innerWidth : 1280
    rootFont.value = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
  }
  function setWidth(side: Side, value: number) {
    const otherSide = side === 'materials' ? 'inspector' : 'materials'
    const other = collapsed.value[otherSide] ? 0 : currentWidth(otherSide)
    preferences.value[side] = Math.round(Math.max(side === 'materials' ? 240 : 280, Math.min(value, 560, available.value - other)))
  }
  function finish() {
    const active = activePointer
    activePointer = null; dragging.value = null
    if (active?.element.hasPointerCapture?.(active.id)) active.element.releasePointerCapture(active.id)
    if (active) save()
  }
  function currentWidth(side: Side) { return side === 'materials' ? materialsWidth.value : inspectorWidth.value }
  function start(side: Side, event: PointerEvent) {
    if (!observing || event.button !== 0 || !event.isPrimary) return
    finish(); measure()
    const element = event.currentTarget as HTMLElement
    activePointer = { element, id: event.pointerId, side, x: event.clientX, width: currentWidth(side) }
    element.setPointerCapture(event.pointerId); dragging.value = side; event.preventDefault()
  }
  function move(event: PointerEvent) {
    const active = activePointer
    if (!active || active.id !== event.pointerId) return
    setWidth(active.side, active.width + (event.clientX - active.x) * (active.side === 'materials' ? 1 : -1))
  }
  function key(side: Side, event: KeyboardEvent) {
    if (event.altKey || event.ctrlKey || event.metaKey) return
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
    const key = side === 'materials' ? 'hideMaterials' : 'hideInspector'
    preferences.value[key] = !preferences.value[key]; save()
  }
  function reset() { finish(); preferences.value = defaults(); save() }
  function changed(event: StorageEvent) { if (event.key === DIRECTOR_LAYOUT_KEY && !activePointer) preferences.value = readPreferences() }
  function observe() {
    if (observing) return
    observing = true
    preferences.value = readPreferences()
    observer ??= new ResizeObserver(measure)
    if (root.value) observer.observe(root.value)
    window.addEventListener('resize', measure)
    window.addEventListener('storage', changed)
    measure()
  }
  function stopObserving() {
    observing = false
    finish()
    observer?.disconnect()
    window.removeEventListener('resize', measure)
    window.removeEventListener('storage', changed)
  }
  watch(root, () => {
    observer?.disconnect()
    if (!observing) return
    if (root.value) observer?.observe(root.value)
    measure()
  })
  onMounted(observe)
  onActivated(observe)
  onDeactivated(stopObserving)
  onBeforeUnmount(stopObserving)
  return { style, collapsed, dragging, materialsWidth, inspectorWidth, start, move, finish, key, toggle, reset }
}
