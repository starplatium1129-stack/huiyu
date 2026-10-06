<template>
  <div ref="host" class="gallery-orbit" :class="{ 'is-reduced': reduced, 'is-dragging': dragging }" :data-position="position" role="group" aria-label="立体观画" tabindex="0">
    <div class="gallery-orbit-surface">
    <div v-for="entry in cards" :key="entry.item.id" class="gallery-orbit-card" :data-orbit-index="entry.index"
      :class="{ 'is-current': entry.index === index }" :style="{ '--orbit-transform': entry.transform, '--orbit-shade': entry.shade, '--orbit-visibility': entry.visibility }" :aria-hidden="entry.index !== index">
      <ZoomableImageViewer v-if="entry.index === index && (currentSrc || previewSrc || preview(entry.item))"
        :src="resolveRuntimeUrl(currentSrc || previewSrc || preview(entry.item))"
        :preview-src="resolveRuntimeUrl(previewSrc || preview(entry.item))" :alt="title(entry.item)" @load="emit('load')" @error="emit('error')">
        <template #fallback><div class="viewer-fallback"><ArchiveIcon name="image" /></div></template>
      </ZoomableImageViewer>
      <button v-else-if="entry.index !== index" class="gallery-orbit-neighbor" type="button" tabindex="-1"
        :aria-label="`查看${title(entry.item)}`" @pointerdown.prevent @click="select(entry.index)">
        <span v-if="preview(entry.item) && !failed.has(preview(entry.item))" class="gallery-orbit-picture" :style="{ '--orbit-image-ratio': imageRatio(entry.item) }">
        <img :src="resolveRuntimeUrl(preview(entry.item))"
          :crossorigin="runtimeResourceCors()" class="gallery-orbit-preview" alt="" decoding="async" draggable="false"
          referrerpolicy="no-referrer" @load="measurePreview(entry.item, $event)" @error="failed.add(preview(entry.item))" />
        <span class="gallery-orbit-shade" aria-hidden="true"></span>
        </span>
        <ArchiveIcon v-else name="image" class="viewer-fallback" />
      </button>
      <div v-else class="viewer-fallback"><ArchiveIcon name="image" /></div>
    </div>
    </div>
    <div class="gallery-orbit-caption">
      <p class="gallery-orbit-title">{{ currentTitle }}</p>
      <div class="gallery-orbit-navigation" data-fluid-glass><span>{{ index + 1 }} / {{ items.length }}</span><input type="range" aria-label="选择作品" min="0" :max="Math.max(0, items.length - 1)" step="1" :value="index" :disabled="items.length < 2" :aria-valuetext="`第 ${index + 1} 幅，共 ${items.length} 幅：${currentTitle}`" @input="select(Number(($event.target as HTMLInputElement).value))" /></div>
      <small>{{ dragging ? '松开选定作品' : '拖拽或滚轮切换 · 方向键逐幅浏览' }}</small>
    </div>
  </div>
</template>

<script setup lang="ts" generic="T extends Pick<ArtworkRecord, 'id' | 'width' | 'height' | 'image_width' | 'image_height' | 'actual'>">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import ZoomableImageViewer from '@/components/visual/ZoomableImageViewer.vue'
import { resolveRuntimeUrl, runtimeResourceCors } from '@/platform/runtimeUrl'
import { useGalleryCoverFlow } from '@/composables/gallery/useGalleryCoverFlow'
import type { ArtworkRecord } from '@/types/artwork'
import '@/assets/css/gallery-orbit.css'

const props = defineProps<{
  items: T[]; index: number; active: boolean; currentSrc: string; previewSrc: string
  cardUrls: Record<string, string>; thumbUrls: Record<string, string>; neighborUrls: Record<string, string>
  title: (item: T) => string
}>()
const emit = defineEmits<{ select: [index: number]; load: []; error: [] }>()
const host = ref<HTMLElement | null>(null), failed = ref(new Set<string>())
const imageRatios = ref<Record<string, number>>({})
const { position, width, reduced, dragging, travel, select, reset } = useGalleryCoverFlow(host, {
  index: () => props.index, count: () => props.items.length, active: () => props.active, select: index => emit('select', index),
})
const currentTitle = computed(() => props.items[props.index] ? props.title(props.items[props.index]) : '')
const cards = computed(() => {
  const motion=travel.value
  const movingIndices=motion ? Array.from({length:Math.ceil(Math.max(...motion.samples))-Math.floor(Math.min(...motion.samples))+5},(_,i)=>Math.floor(Math.min(...motion.samples))-2+i) : []
  const indices = reduced.value ? [props.index] : [...new Set([
    Math.floor(position.value) - 2, Math.floor(position.value) - 1, Math.floor(position.value),
    Math.ceil(position.value), Math.ceil(position.value) + 1, Math.ceil(position.value) + 2, props.index, ...movingIndices,
  ])].sort((a, b) => a - b)
  return indices.flatMap(index => {
    if(!props.items[index])return []
    const style=cardStyle(index)
    return [{ index,item:props.items[index],...style,visibility:motion ? 'visible' : style.visibility }]
  })
})
function preview(item: T) { return props.cardUrls[item.id] || props.neighborUrls[item.id] || props.thumbUrls[item.id] || '' }
function imageRatio(item: T) {
  const width = Number(item.width || item.image_width || item.actual?.width), height = Number(item.height || item.image_height || item.actual?.height)
  return imageRatios.value[item.id] || (width > 0 && height > 0 && Number.isFinite(width / height) ? width / height : .75)
}
function measurePreview(item: T, event: Event) {
  const image = event.target as HTMLImageElement
  if (image.complete && image.naturalWidth && image.naturalHeight) imageRatios.value[item.id] = image.naturalWidth / image.naturalHeight
}
function cardStyle(index: number, at = position.value) {
  if (reduced.value) return { transform: 'none', shade: 0, visibility: 'visible' }
  const distance = index - at, depth = Math.abs(distance)
  return {
    transform: `translateX(${Math.sign(distance) * (Math.min(depth, 1) * width.value * .34 + Math.max(0, depth - 1) * width.value * .12)}px) translateZ(${-Math.min(depth, 3) * 150}px) rotateY(${-Math.max(-1, Math.min(1, distance)) * 58}deg) scale(${Math.max(.78, 1 - depth * .045)})`,
    shade: Math.min(.45, depth * .18), visibility: depth > 3 ? 'hidden' : 'visible',
  }
}
let animations:Animation[]=[]
function cancelTravel(){animations.forEach(animation=>animation.cancel());animations=[]}
watch(travel,async motion=>{
  cancelTravel()
  if(!motion)return
  await nextTick()
  if(travel.value!==motion || !host.value)return
  for(const card of host.value.querySelectorAll<HTMLElement>('.gallery-orbit-card')) {
    const index=Number(card.dataset.orbitIndex)
    const styles=motion.samples.map(at=>cardStyle(index,at))
    const animation=card.animate(styles.map(style=>({transform:style.transform,opacity:style.visibility==='hidden'?0:1})),{duration:motion.duration,fill:'both',easing:'linear'})
    animation.id='gallery-cover-flow';animations.push(animation)
    const shade=card.querySelector<HTMLElement>('.gallery-orbit-shade')
    if(shade) animations.push(shade.animate(styles.map(style=>({opacity:style.shade})),{duration:motion.duration,fill:'both',easing:'linear'}))
  }
},{flush:'post'})
onBeforeUnmount(cancelTravel)
watch(() => props.items.map(item => item.id).join('\u0000'), () => { failed.value.clear(); imageRatios.value = {}; reset() })
</script>
