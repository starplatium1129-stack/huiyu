<template>
  <div ref="host" class="gallery-orbit" :class="{ 'is-reduced': reduced, 'is-dragging': dragging }" :data-position="position" role="group" aria-label="立体观画" tabindex="0">
    <div class="gallery-orbit-surface">
    <div v-for="entry in cards" :key="entry.item.id" class="gallery-orbit-card"
      :class="{ 'is-current': entry.index === index }" :style="{ '--orbit-transform': entry.transform, '--orbit-opacity': entry.opacity, '--orbit-visibility': entry.visibility }" :aria-hidden="entry.index !== index">
      <ZoomableImageViewer v-if="entry.index === index && (currentSrc || previewSrc || preview(entry.item))"
        :src="resolveRuntimeUrl(currentSrc || previewSrc || preview(entry.item))"
        :preview-src="resolveRuntimeUrl(previewSrc || preview(entry.item))" :alt="title(entry.item)">
        <template #fallback><div class="viewer-fallback"><ArchiveIcon name="image" /></div></template>
      </ZoomableImageViewer>
      <button v-else-if="entry.index !== index" class="gallery-orbit-neighbor" type="button" tabindex="-1"
        :aria-label="`查看${title(entry.item)}`" @pointerdown.prevent @click="select(entry.index)">
        <img v-if="preview(entry.item) && !failed.has(preview(entry.item))" :src="resolveRuntimeUrl(preview(entry.item))"
          :crossorigin="runtimeResourceCors()" class="gallery-orbit-preview" alt="" decoding="async" draggable="false"
          referrerpolicy="no-referrer" @error="failed.add(preview(entry.item))" />
        <ArchiveIcon v-else name="image" class="viewer-fallback" />
      </button>
      <div v-else class="viewer-fallback"><ArchiveIcon name="image" /></div>
    </div>
    </div>
    <div class="gallery-orbit-caption">
      <p class="gallery-orbit-title">{{ currentTitle }}</p>
      <div class="gallery-orbit-navigation"><span>{{ index + 1 }} / {{ items.length }}</span><input type="range" aria-label="选择作品" min="0" :max="Math.max(0, items.length - 1)" step="1" :value="index" :disabled="items.length < 2" :aria-valuetext="`第 ${index + 1} 幅，共 ${items.length} 幅：${currentTitle}`" @input="select(Number(($event.target as HTMLInputElement).value))" /></div>
      <small>{{ dragging ? '松开选定作品' : '拖拽或滚轮切换 · 方向键逐幅浏览' }}</small>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, type CSSProperties } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import ZoomableImageViewer from '@/components/visual/ZoomableImageViewer.vue'
import { resolveRuntimeUrl, runtimeResourceCors } from '@/platform/runtimeUrl'
import { useGalleryCoverFlow } from '@/composables/gallery/useGalleryCoverFlow'
import type { ArtworkRecord } from '@/types/artwork'

const props = defineProps<{
  items: ArtworkRecord[]; index: number; active: boolean; currentSrc: string; previewSrc: string
  cardUrls: Record<string, string>; thumbUrls: Record<string, string>; neighborUrls: Record<string, string>
  title: (item: ArtworkRecord) => string
}>()
const emit = defineEmits<{ select: [index: number] }>()
const host = ref<HTMLElement | null>(null), failed = ref(new Set<string>())
const { position, width, reduced, dragging, select, reset } = useGalleryCoverFlow(host, {
  index: () => props.index, count: () => props.items.length, active: () => props.active, select: index => emit('select', index),
})
const currentTitle = computed(() => props.items[props.index] ? props.title(props.items[props.index]) : '')
const cards = computed(() => {
  const indices = reduced.value ? [props.index] : [...new Set([
    Math.floor(position.value) - 2, Math.floor(position.value) - 1, Math.floor(position.value),
    Math.ceil(position.value), Math.ceil(position.value) + 1, Math.ceil(position.value) + 2, props.index,
  ])].sort((a, b) => a - b)
  return indices.flatMap(index => props.items[index] ? [{ index, item: props.items[index], ...cardStyle(index) }] : [])
})
function preview(item: ArtworkRecord) { return props.cardUrls[item.id] || props.neighborUrls[item.id] || props.thumbUrls[item.id] || '' }
function cardStyle(index: number): CSSProperties {
  if (reduced.value) return { transform: 'none', opacity: 1, visibility: 'visible' }
  const distance = index - position.value, depth = Math.abs(distance)
  return {
    transform: `translateX(${Math.sign(distance) * (Math.min(depth, 1) * width.value * .34 + Math.max(0, depth - 1) * width.value * .12)}px) translateZ(${-Math.min(depth, 3) * 150}px) rotateY(${-Math.max(-1, Math.min(1, distance)) * 58}deg) scale(${Math.max(.78, 1 - depth * .045)})`,
    opacity: depth > 3 ? 0 : Math.max(.45, 1 - depth * .18), visibility: depth > 3 ? 'hidden' : 'visible',
  }
}
watch(() => props.items.map(item => item.id).join('\u0000'), () => { failed.value.clear(); reset() })
</script>
