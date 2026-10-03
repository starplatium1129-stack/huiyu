<template>
  <div ref="host" class="gallery-orbit" :class="{ 'is-reduced': reduced }" :data-position="position" aria-label="立体观画">
    <div v-for="entry in cards" :key="entry.item.id" class="gallery-orbit-card"
      :class="{ 'is-current': entry.index === index }" :style="{ '--orbit-transform': entry.transform, '--orbit-opacity': entry.opacity, '--orbit-visibility': entry.visibility }" :aria-hidden="entry.index !== index">
      <ZoomableImageViewer v-if="entry.index === index && (currentSrc || previewSrc || preview(entry.item))"
        :src="resolveRuntimeUrl(currentSrc || previewSrc || preview(entry.item))"
        :preview-src="resolveRuntimeUrl(previewSrc || preview(entry.item))" :alt="title(entry.item)">
        <template #fallback><div class="viewer-fallback"><ArchiveIcon name="image" /></div></template>
      </ZoomableImageViewer>
      <button v-else-if="entry.index !== index" class="gallery-orbit-neighbor" type="button" tabindex="-1"
        :aria-label="`查看${title(entry.item)}`" @pointerdown.prevent @click="emit('select', entry.index)">
        <img v-if="preview(entry.item) && !failed.has(preview(entry.item))" :src="resolveRuntimeUrl(preview(entry.item))"
          :crossorigin="runtimeResourceCors()" class="gallery-orbit-preview" alt="" decoding="async" draggable="false"
          referrerpolicy="no-referrer" @error="failed.add(preview(entry.item))" />
        <ArchiveIcon v-else name="image" class="viewer-fallback" />
      </button>
      <div v-else class="viewer-fallback"><ArchiveIcon name="image" /></div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onDeactivated, onMounted, ref, watch, type CSSProperties } from 'vue'
import { useEventListener, useResizeObserver } from '@vueuse/core'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import ZoomableImageViewer from '@/components/visual/ZoomableImageViewer.vue'
import { resolveRuntimeUrl, runtimeResourceCors } from '@/platform/runtimeUrl'
import { createFluidMotion } from '@/utils/fluidSpring'
import { prefersReducedMotion } from '@/utils/motionPreference'
import type { ArtworkRecord } from '@/types/artwork'

const props = defineProps<{
  items: ArtworkRecord[]; index: number; active: boolean; currentSrc: string; previewSrc: string
  cardUrls: Record<string, string>; thumbUrls: Record<string, string>; neighborUrls: Record<string, string>
  title: (item: ArtworkRecord) => string
}>()
const emit = defineEmits<{ select: [index: number] }>()
const host = ref<HTMLElement | null>(null), position = ref(props.index), width = ref(800)
const reduced = ref(prefersReducedMotion()), failed = ref(new Set<string>())
let motion: ReturnType<typeof createFluidMotion> | undefined
const cards = computed(() => {
  const indices = reduced.value ? [props.index] : [...new Set([
    Math.floor(position.value) - 1, Math.floor(position.value), Math.ceil(position.value), Math.ceil(position.value) + 1,
    props.index - 1, props.index, props.index + 1,
  ])].sort((a, b) => a - b)
  return indices.flatMap(index => props.items[index] ? [{ index, item: props.items[index], ...cardStyle(index) }] : [])
})
function preview(item: ArtworkRecord) { return props.cardUrls[item.id] || props.neighborUrls[item.id] || props.thumbUrls[item.id] || '' }
function start() {
  motion?.dispose()
  position.value = props.index
  motion = createFluidMotion([props.index], ([value]) => { position.value = value }, 4.4)
}
function preference() { reduced.value = prefersReducedMotion(); if (reduced.value) motion?.settle() }
function cardStyle(index: number): CSSProperties {
  if (reduced.value) return { transform: 'none', opacity: 1, visibility: 'visible' }
  const distance = index - position.value, depth = Math.abs(distance)
  return {
    transform: `translateX(${distance * width.value * .355}px) translateZ(${-Math.min(depth, 3) * 270}px) rotateY(${-Math.max(-1, Math.min(1, distance)) * 40}deg) scale(${Math.max(.6, 1 - depth * .07)})`,
    opacity: depth > 2.1 ? 0 : Math.max(.26, 1 - depth * .22), visibility: depth > 2.1 ? 'hidden' : 'visible',
  }
}
watch(() => props.index, index => { if (props.active) motion?.to([index]) })
watch(() => props.active, active => { if (active) start(); else { motion?.dispose(); motion = undefined } })
watch(() => props.items.map(item => item.id).join('\u0000'), () => { failed.value.clear(); if (props.active) start() })
useResizeObserver(host, entries => { width.value = entries[0]?.contentRect.width || width.value })
useEventListener(window, 'atelier:motion-preference', preference)
useEventListener(window.matchMedia('(prefers-reduced-motion: reduce)'), 'change', preference)
onMounted(() => { if (props.active) start() })
onDeactivated(() => { motion?.dispose(); motion = undefined })
onBeforeUnmount(() => motion?.dispose())
</script>
