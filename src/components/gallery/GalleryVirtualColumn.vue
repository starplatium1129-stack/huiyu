<template>
  <div ref="root" class="gallery-virtual-column" @focusin="syncFocus" @focusout="queueFocus">
    <template v-for="entry in entries" :key="entry.key">
      <div v-if="entry.item" class="virtual-card" :data-virtual-id="String(entry.item.id)"
        :style="{ paddingBottom: entry.index === items.length - 1 ? '0px' : `${gap}px` }">
        <slot :item="entry.item" />
      </div>
      <div v-else :style="{ height: `${entry.height}px` }" aria-hidden="true" />
    </template>
  </div>
</template>
<script setup lang="ts">
import { computed, nextTick, onActivated, onDeactivated, onMounted, onScopeDispose, ref, shallowRef, triggerRef, watch } from 'vue'
import type { ArtworkRecord } from '@/types/artwork'

const props = defineProps<{ items: ArtworkRecord[]; ratioOf: (item: ArtworkRecord) => number; enabled: boolean }>()
const emit = defineEmits<{ rendered: [] }>()
const root = ref<HTMLElement | null>(null), width = ref(360), gap = ref(20)
const measured = shallowRef(new Map<string | number, { width: number; height: number }>())
const start = ref(0), end = ref(12), focused = ref<string | null>(null)
let active = false, frame = 0, observer: ResizeObserver | undefined
const observed = new Set<Element>()
const itemIndex = computed(() => new Map(props.items.map((item, index) => [String(item.id), { id: item.id, index }])))
const offsets = computed(() => {
  const result = [0]
  for (const item of props.items) {
    const size = measured.value.get(item.id), ratio = props.ratioOf(item) || .75
    const height = size?.width === width.value ? size.height : width.value / ratio + 68 + gap.value
    result.push(result[result.length - 1] + height)
  }
  return result
})
type Entry = { key: string; item?: ArtworkRecord; index: number; height?: number }
const entries = computed(() => {
  const result: Entry[] = [], positions = offsets.value
  const length = props.items.length
  const first = props.enabled ? Math.min(start.value, length) : 0
  const last = props.enabled ? Math.max(first, Math.min(end.value, length)) : length
  const focusIndex = focused.value === null ? undefined : itemIndex.value.get(focused.value)?.index
  let cursor = 0
  function append(index: number) {
    const item = props.items[index]
    const skipped = positions[index] - positions[cursor]
    if (skipped) result.push({ key: `space:${item.id}`, index, height: skipped })
    result.push({ key: `item:${item.id}`, item, index })
    cursor = index + 1
  }
  // Only visit the viewport and its focused card; prefix sums account for gaps.
  if (focusIndex !== undefined && focusIndex < first) append(focusIndex)
  for (let index = first; index < last; index++) append(index)
  if (focusIndex !== undefined && focusIndex >= last) append(focusIndex)
  const tail = positions[length] - positions[cursor]
  if (tail) result.push({ key: 'tail', index: length, height: tail })
  return result
})
function lowerBound(value: number) {
  const positions = offsets.value
  let left = 0, right = positions.length
  while (left < right) { const middle = (left + right) >>> 1; if (positions[middle] < value) left = middle + 1; else right = middle }
  return left
}
function update() {
  frame = 0
  if (!active || !root.value?.getClientRects().length) return
  const top = root.value.getBoundingClientRect().top
  start.value = Math.max(0, lowerBound(-top - 1200) - 1)
  end.value = Math.min(props.items.length, lowerBound(innerHeight - top + 1200) + 1)
}
function schedule() { if (active && !frame) frame = requestAnimationFrame(update) }
function syncFocus() {
  const element = document.activeElement
  focused.value = element instanceof HTMLElement && root.value?.contains(element)
    ? element.closest<HTMLElement>('[data-virtual-id]')?.dataset.virtualId ?? null : null
}
function queueFocus() { queueMicrotask(() => { if (active) syncFocus() }) }
function observeCards() {
  if (!active || !observer) return
  const cards = new Set(root.value?.querySelectorAll<HTMLElement>('.virtual-card') || [])
  for (const element of observed) if (!cards.has(element as HTMLElement)) { observer.unobserve(element); observed.delete(element) }
  for (const element of cards) if (!observed.has(element)) { observed.add(element); observer.observe(element) }
  emit('rendered')
}
watch(entries, () => { void nextTick(observeCards) }, { flush: 'post' })
watch(offsets, schedule, { flush: 'post' })
watch(() => props.items, () => {
  const ids = new Set(props.items.map(item => item.id))
  measured.value = new Map([...measured.value].filter(([id]) => ids.has(id)))
}, { flush: 'post' })
function activate() {
  if (active) return
  active = true
  observer = new ResizeObserver(records => {
    const sizes = measured.value
    let changed = false
    const byId = itemIndex.value
    for (const record of records) {
      if (record.target === root.value) {
        if (record.contentRect.width <= 0) continue
        width.value = record.contentRect.width
        gap.value = parseFloat(getComputedStyle(record.target).rowGap) || 0
      } else {
        const id = byId.get((record.target as HTMLElement).dataset.virtualId || '')?.id
        if (id === undefined) continue
        const height = record.borderBoxSize[0]?.blockSize ?? record.target.getBoundingClientRect().height
        const previous = sizes.get(id)
        if (!previous || previous.width !== width.value || Math.abs(previous.height - height) > 1) {
          sizes.set(id, { width: width.value, height }); changed = true
        }
      }
    }
    if (changed) triggerRef(measured)
    schedule()
  })
  if (root.value) observer.observe(root.value)
  window.addEventListener('scroll', schedule, { capture: true, passive: true })
  window.addEventListener('resize', schedule, { passive: true })
  observeCards(); schedule()
}
function deactivate() {
  active = false; cancelAnimationFrame(frame); frame = 0
  observer?.disconnect(); observer = undefined; observed.clear()
  window.removeEventListener('scroll', schedule, true); window.removeEventListener('resize', schedule)
}
onMounted(activate); onActivated(activate); onDeactivated(deactivate); onScopeDispose(deactivate)
</script>
<style scoped>
.gallery-col.gallery-virtual-column { display:block; overflow-anchor:none; }
.virtual-card { display:flow-root; }
</style>
