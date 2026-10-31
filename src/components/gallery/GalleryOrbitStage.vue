<template>
  <div ref="host" class="gallery-orbit" :class="{ 'is-reduced': reduced, 'is-dragging': dragging }" :style="{ '--orbit-perspective': `${1400 * depthScale}px` }" role="group" aria-label="立体观画" tabindex="0">
    <div class="gallery-orbit-surface">
    <div v-for="entry in cards" :key="entry.item.id" class="gallery-orbit-card" :data-orbit-index="entry.index"
      :class="{ 'is-current': entry.index === index }" :aria-hidden="entry.index !== index">
      <ZoomableImageViewer v-if="entry.index === index && (currentSrc || previewSrc || preview(entry.item) || loadFailed)"
        wheel-on-image-only
        :src="resolveRuntimeUrl(currentSrc || previewSrc || preview(entry.item))"
        :preview-src="resolveRuntimeUrl(previewSrc || preview(entry.item))" :image-key="entry.item.id" :load-failed="loadFailed" :reload="reload" :alt="title(entry.item)" @load="currentReady = true; emit('load')" @error="emit('error')">
        <template #fallback><div class="viewer-fallback"><ArchiveIcon name="image" /></div></template>
      </ZoomableImageViewer>
      <button v-if="entry.index !== index || preview(entry.item)" v-show="entry.index !== index || !currentReady"
        class="gallery-orbit-neighbor" type="button" tabindex="-1" :inert="entry.index === index" :aria-hidden="entry.index === index"
        :aria-label="`查看${title(entry.item)}`" @pointerdown.prevent @click="select(entry.index)">
        <span v-if="preview(entry.item) && !failed.has(preview(entry.item))" class="gallery-orbit-picture" :style="{ '--orbit-image-ratio': imageRatio(entry.item) }">
        <img :src="resolveRuntimeUrl(preview(entry.item))"
          :crossorigin="runtimeResourceCors()" class="gallery-orbit-preview" alt="" decoding="async" draggable="false"
          referrerpolicy="no-referrer" @load="measurePreview(entry.item, $event)" @error="failed.add(preview(entry.item))" />
        <span class="gallery-orbit-shade" aria-hidden="true"></span>
        </span>
        <ArchiveIcon v-else name="image" class="viewer-fallback" />
      </button>
      <div v-if="entry.index === index && !(currentSrc || previewSrc || preview(entry.item) || loadFailed)" class="viewer-fallback"><ArchiveIcon name="image" /></div>
    </div>
    </div>
    <div class="gallery-orbit-caption">
      <p class="gallery-orbit-title">{{ currentTitle }}</p>
      <div class="gallery-orbit-navigation" data-fluid-glass><span>{{ index + 1 }} / {{ total ?? items.length }}</span><input type="range" aria-label="选择作品" min="0" :max="Math.max(0, items.length - 1)" step="1" :value="index" :disabled="items.length < 2" :aria-valuetext="`第 ${index + 1} 幅，共 ${total ?? items.length} 幅：${currentTitle}`" @input="select(Number(($event.target as HTMLInputElement).value))" /></div>
      <small>{{ dragging ? '松开选定作品' : '图上滚轮缩放 · 图外滚轮切换 · 方向键逐幅浏览' }}</small>
    </div>
  </div>
</template>

<script setup lang="ts" generic="T extends Pick<ArtworkRecord, 'id' | 'width' | 'height' | 'image_width' | 'image_height' | 'actual'>">
import { computed, nextTick, onBeforeUnmount, onMounted, onUpdated, reactive, ref, watch } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import ZoomableImageViewer from '@/components/visual/ZoomableImageViewer.vue'
import { resolveRuntimeUrl, runtimeResourceCors } from '@/platform/runtimeUrl'
import { useGalleryCoverFlow } from '@/composables/gallery/useGalleryCoverFlow'
import type { ArtworkRecord } from '@/types/artwork'
import '@/assets/css/gallery-orbit.css'

const props = defineProps<{
  total?: number; items: T[]; index: number; active: boolean; currentSrc: string; previewSrc: string
  cardUrls: Record<string, string>; thumbUrls: Record<string, string>; neighborUrls: Record<string, string>
  title: (item: T) => string
  loadFailed?: boolean; reload?: () => Promise<void>
}>()
const emit = defineEmits<{ select: [index: number]; load: []; error: [] }>()
const host = ref<HTMLElement | null>(null), failed = ref(new Set<string>())
const currentReady = ref(false)
watch(() => props.items[props.index]?.id, () => { currentReady.value = false }, { flush: 'sync' })
const imageRatios = reactive(new Map<string, number>())
let cardNodes: { card: HTMLElement; index: number; shade: HTMLElement | null }[] = []
function refreshCards() {
  cardNodes = Array.from(host.value?.querySelectorAll<HTMLElement>('.gallery-orbit-card') ?? [], card => ({
    card, index: Number(card.dataset.orbitIndex), shade: card.querySelector<HTMLElement>('.gallery-orbit-shade'),
  }))
}
onMounted(refreshCards)
const { getPosition, windowCenter, width, reduced, dragging, travel, select, reset, startTravel, finishTravel, resumeTravel } = useGalleryCoverFlow(host, {
  index: () => props.index, count: () => props.items.length, active: () => props.active, select: index => emit('select', index),
  present: paint,
})
// Keep the established desktop depth proportions as the stage grows: fixed
// perspective would magnify a rotated cover's near edge on a 4K viewport.
const depthScale = computed(() => Math.max(1, width.value / 1100))
const currentTitle = computed(() => props.items[props.index] ? props.title(props.items[props.index]) : '')
const cards = computed(() => {
  const motion = travel.value
  // A short native flight retains its finite path. Long jumps and dragging
  // replace only the six neighboring records when the window crosses a cover.
  const first = motion ? Math.floor(Math.min(...motion.samples)) : windowCenter.value
  const last = motion ? Math.ceil(Math.max(...motion.samples)) : windowCenter.value + 1
  const indices = reduced.value ? [props.index] : [...new Set([
    ...Array.from({ length:last - first + 5 }, (_, index) => first - 2 + index), props.index,
  ])]
  return indices.flatMap(index => {
    if(!props.items[index])return []
    return [{ index, item:props.items[index] }]
  })
})
function preview(item: T) { return props.cardUrls[item.id] || props.neighborUrls[item.id] || props.thumbUrls[item.id] || '' }
function imageRatio(item: T) {
  const width = Number(item.width || item.image_width || item.actual?.width), height = Number(item.height || item.image_height || item.actual?.height)
  return imageRatios.get(String(item.id)) || (width > 0 && height > 0 && Number.isFinite(width / height) ? width / height : .75)
}
function measurePreview(item: T, event: Event) {
  const image = event.target as HTMLImageElement
  if (image.complete && image.naturalWidth && image.naturalHeight) imageRatios.set(String(item.id), image.naturalWidth / image.naturalHeight)
}
function cardStyle(index: number, at: number) {
  if (reduced.value) return { transform: 'none', shade: 0, visibility: 'visible' }
  const distance = index - at, depth = Math.abs(distance)
  return {
    transform: `translateX(${Math.sign(distance) * (Math.min(depth, 1) * width.value * .34 + Math.max(0, depth - 1) * width.value * .12)}px) translateZ(${-Math.min(depth, 3) * 150 * depthScale.value}px) rotateY(${-Math.max(-1, Math.min(1, distance)) * 58}deg) scale(${Math.max(.78, 1 - depth * .045)})`,
    shade: Math.min(.45, depth * .18), visibility: depth > 3 ? 'hidden' : 'visible',
  }
}
function paint(at: number) {
  if (!host.value?.isConnected) return
  for (const { card, index, shade } of cardNodes) {
    const style = cardStyle(index, at)
    card.style.transform = style.transform
    card.style.opacity = style.visibility === 'hidden' ? '0' : '1'
    card.style.visibility = style.visibility
    if (shade) shade.style.opacity = String(style.shade)
  }
}
let animations: Animation[] = []
let focusRevision = 0
watch(() => props.index, async () => {
  const revision = ++focusRevision, root = host.value
  const focused = document.activeElement
  if (!(focused instanceof HTMLElement) || !root?.querySelector('.gallery-orbit-card.is-current .zoomable-image-viewer')?.contains(focused)) return
  await nextTick()
  if (revision !== focusRevision || !props.active || !root.isConnected) return
  const modal = document.querySelector('dialog:modal')
  if (modal && !modal.contains(root)) return
  // Only the departing picture loses its node; navigation and slider controls
  // retain their own focus through selection and native timeline updates.
  ;(root.querySelector<HTMLElement>('.gallery-orbit-card.is-current .zoomable-image-viewer') ?? root).focus({ preventScroll:true })
})
function cancelTravel() { animations.forEach(animation => animation.cancel()); animations = [] }
watch(travel, async motion => {
  cancelTravel()
  if (!motion) return
  await nextTick()
  if (travel.value !== motion || !host.value) return
  paint(motion.to)
  try {
    for (const { card, index, shade } of cardNodes) {
      const styles = motion.samples.map(at => cardStyle(index, at))
      // Discrete visibility follows the same samples as opacity, so transparent
      // edge covers cannot remain pointer targets during a native flight.
      const animation = card.animate(styles.map(style => ({ transform:style.transform, opacity:style.visibility === 'hidden' ? 0 : 1, visibility:style.visibility })), { duration:motion.duration, fill:'both', easing:'linear' })
      animation.id = 'gallery-cover-flow'; animations.push(animation)
      void animation.finished.catch(() => {})
      if (shade) {
        const effect = shade.animate(styles.map(style => ({ opacity:style.shade })), { duration:motion.duration, fill:'both', easing:'linear' })
        animations.push(effect); void effect.finished.catch(() => {})
      }
    }
    if (!animations.length) { finishTravel(motion); return }
    startTravel(motion)
    void animations[0].finished.then(() => finishTravel(motion), () => resumeTravel(motion))
  } catch {
    // The same private spring continues if an optional native timeline fails.
    resumeTravel(motion)
  }
}, { flush:'sync' })
onUpdated(() => { refreshCards(); paint(travel.value?.to ?? getPosition()) })
onBeforeUnmount(() => { focusRevision++; cancelTravel(); cardNodes = [] })
watch(() => props.items.map(item => item.id), (items, previous) => { if (items.length >= previous.length && previous.every((id, index) => id === items[index])) return; failed.value.clear(); imageRatios.clear(); reset() })
</script>
