<template>
  <div ref="root" class="gallery-virtual-rows" :style="enabled ? { height: `${virtualizer.getTotalSize()}px` } : undefined"
    @focusin="syncFocus" @focusout="queueFocus">
    <div v-for="entry in entries" :key="entry.row.id" :ref="measureCard" class="virtual-row"
      :data-index="entry.index" :data-virtual-id="String(entry.row.id)"
      :style="{ paddingBottom: entry.index === rows.length - 1 ? '0px' : `${gap}px`,
        ...(enabled ? { position: 'absolute', top: '0', left: '0', width: '100%', transform: `translateY(${entry.start - scrollMargin}px)` } : {}) }">
      <div class="gallery-artwork-row" :style="{ width: `${entry.row.fill * 100}%` }">
        <div v-for="item in entry.row.items" :key="item.id" class="gallery-row-card" :style="{ flexGrow: galleryRatio(ratioOf(item)) }">
          <slot :item="item" />
        </div>
      </div>
    </div>
  </div>
</template>
<script lang="ts">
const virtualGroups = new Map<HTMLElement, (top: number) => void>()
let pageResize: ResizeObserver | undefined
let offsetFrame = 0

function scheduleGroupOffsets() {
  if (offsetFrame || !virtualGroups.size) return
  offsetFrame = requestAnimationFrame(() => {
    offsetFrame = 0
    const positions: Array<[(top: number) => void, number]> = []
    for (const [element, publish] of virtualGroups) {
      if (!element.offsetParent) continue
      // The window virtualizer uses document coordinates. Layout offsets ignore
      // scroll and the temporary transforms applied by the route entrance.
      let top = element.offsetTop
      for (let parent: Element | null = element.offsetParent; parent instanceof HTMLElement; parent = parent.offsetParent) {
        top += parent.offsetTop + parent.clientTop
      }
      positions.push([publish, top])
    }
    for (const [publish, top] of positions) publish(top)
  })
}

function observeGroupOffset(element: HTMLElement, publish: (top: number) => void) {
  if (!virtualGroups.size) {
    if (typeof ResizeObserver !== 'undefined') {
      pageResize = new ResizeObserver(scheduleGroupOffsets)
      pageResize.observe(document.body)
    }
    window.addEventListener('resize', scheduleGroupOffsets, { passive: true })
  }
  virtualGroups.set(element, publish)
  scheduleGroupOffsets()
  return () => {
    virtualGroups.delete(element)
    if (virtualGroups.size) return
    pageResize?.disconnect()
    pageResize = undefined
    window.removeEventListener('resize', scheduleGroupOffsets)
    cancelAnimationFrame(offsetFrame)
    offsetFrame = 0
  }
}
</script>
<script setup lang="ts">
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch, type ComponentPublicInstance } from 'vue'
import { useResizeObserver } from '@vueuse/core'
import { defaultRangeExtractor, useWindowVirtualizer, type Range } from '@tanstack/vue-virtual'
import type { ArtworkRecord } from '@/types/artwork'
import { galleryRatio, type GalleryRow } from '@/composables/gallery/useMasonryWall'

const props = defineProps<{ rows: GalleryRow[]; ratioOf: (item: ArtworkRecord) => number; enabled: boolean }>()
const emit = defineEmits<{ rendered: [] }>()
const root = ref<HTMLElement | null>(null), active = ref(false), width = ref(360), gap = ref(20), scrollMargin = ref(0)
const focused = ref<string | null>(null)
const itemIndex = computed(() => new Map(props.rows.flatMap((row, index) => row.items.map(item => [String(item.id), index] as const))))
const rangeExtractor = computed(() => {
  const index = focused.value === null ? undefined : itemIndex.value.get(focused.value)
  return (range: Range) => {
    const indices = defaultRangeExtractor(range)
    if (index !== undefined && !indices.includes(index)) indices.push(index)
    return indices.sort((a, b) => a - b)
  }
})
const virtualizer = useWindowVirtualizer<HTMLElement>(computed(() => ({
  count: props.enabled ? props.rows.length : 0,
  enabled: active.value && props.enabled,
  scrollMargin: scrollMargin.value,
  getItemKey: (index: number) => props.rows[index]!.id,
  estimateSize: (index: number) => (width.value * props.rows[index]!.fill - gap.value * (props.rows[index]!.items.length - 1)) / props.rows[index]!.ratio + 68 + (index < props.rows.length - 1 ? gap.value : 0),
  overscan: 4,
  // Keep the focused artwork mounted while TanStack owns the visible range.
  rangeExtractor: rangeExtractor.value,
})))
const entries = computed(() => props.enabled
  ? virtualizer.value.getVirtualItems().map(entry => ({ row: props.rows[entry.index]!, index: entry.index, start: entry.start }))
  : props.rows.map((row, index) => ({ row, index, start: 0 })))
watch([active, () => props.enabled, root], ([live, enabled, element], _, onCleanup) => {
  if (live && enabled && element) onCleanup(observeGroupOffset(element, top => { scrollMargin.value = top }))
}, { flush: 'post' })
watch(() => props.rows, () => {
  if (active.value && props.enabled) scheduleGroupOffsets()
}, { flush: 'post' })
useResizeObserver(computed(() => active.value ? root.value : null), records => {
  const element = root.value, bounds = records[0]?.contentRect
  if (!element || !bounds?.width) return
  width.value = bounds.width
  gap.value = parseFloat(getComputedStyle(element).rowGap) || 0
  if (props.enabled) scheduleGroupOffsets()
})
function measureCard(element: Element | ComponentPublicInstance | null) {
  if (active.value && props.enabled) virtualizer.value.measureElement(element instanceof HTMLElement ? element : null)
}
function syncFocus() {
  const element = document.activeElement
  focused.value = element instanceof HTMLElement && root.value?.contains(element)
    ? element.closest<HTMLElement>('[data-card-id]')?.dataset.cardId ?? null : null
}
function queueFocus() { queueMicrotask(() => { if (active.value) syncFocus() }) }
watch(width, () => virtualizer.value.measure(), { flush: 'post' })
watch(entries, () => { void nextTick(() => { if (active.value) emit('rendered') }) }, { flush: 'post' })
function activate() { active.value = true }
function deactivate() { active.value = false }
onMounted(activate)
onActivated(activate)
onDeactivated(deactivate)
onBeforeUnmount(deactivate)
</script>
<style scoped>
.gallery-virtual-rows { --wall-gap:var(--workspace-panel-gap,var(--s-4)); position:relative; display:block; min-width:0; row-gap:var(--wall-gap); overflow-anchor:none; }
.virtual-row { display:flow-root; }
.gallery-artwork-row { display:flex; align-items:start; gap:var(--wall-gap); min-width:0; }
.gallery-row-card { flex:1 1 0; min-width:0; }
@media (max-width:820px) { .gallery-virtual-rows { --wall-gap:var(--s-3); } }
</style>
