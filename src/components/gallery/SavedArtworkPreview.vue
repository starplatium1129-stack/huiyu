<template>
  <Teleport to="body">
    <FluidTransition :surface="surface" @after-leave="finishClose">
    <div v-show="!closing" ref="dialog" class="art-viewer saved-artwork-preview" :class="{ open: !closing }" data-image-transition
      role="dialog" aria-modal="true" aria-label="最近作品预览" :aria-hidden="closing" :inert="closing" @keydown="onKey">
      <ArtworkViewerStage :items="items" :index="index" :active="!closing" :original="original" :src="viewerUrl"
        :preview-src="surface.previewSrc.value || thumbnail(current)" :card-urls="previews" :neighbor-urls="neighborPreviews" :load-failed="viewerLoadFailed" :reload="retryViewerImage" :title="title"
        @select="select" @close="close" @toggle-original="toggleOriginal" @close-button="closeButton = $event">
        <template #tools>
          <div class="saved-preview-resume" data-viewer-chrome>
            <button class="btn btn-primary" type="button" @click="resume"><ArchiveIcon name="spark" />{{ artworkContinueTarget(current).label }}</button>
          </div>
        </template>
      </ArtworkViewerStage>
    </div>
    </FluidTransition>
  </Teleport>
</template>
<script setup lang="ts">
import '@/assets/css/viewer.css'
import '@/assets/css/gallery-viewer.css'
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import type { ArtworkRecord } from '@/types/artwork'
import { artworkContinueTarget } from '@/utils/artworkNavigation'
import { useGalleryViewer } from '@/composables/gallery/useGalleryViewer'
import { useFocusTrap } from '@/composables/useFocusTrap'
import { useArtworkViewerSurface } from '@/composables/useArtworkViewerSurface'
import FluidTransition from '@/components/visual/FluidTransition.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import ArtworkViewerStage from './ArtworkViewerStage.vue'

const props = defineProps<{ item: ArtworkRecord; items: ArtworkRecord[]; source: HTMLImageElement | null;
  sourceFor: (id: string | number) => HTMLImageElement | null; thumbnail: (item: ArtworkRecord) => string; request: number }>()
const emit = defineEmits<{ close: []; resume: [item: ArtworkRecord] }>()
const items = computed(() => props.items)
const selectedId = ref(props.item.id)
const index = computed(() => Math.max(0, items.value.findIndex(item => item.id === selectedId.value)))
const previews = computed(() => Object.fromEntries(items.value.map(item => [item.id, props.thumbnail(item)])))
const title = (item: ArtworkRecord) => item.sceneTitle || item.story || '未命名作品'
const original = ref(false), closing = ref(false), dialog = ref<HTMLElement | null>(null), closeButton = ref<HTMLElement | null>(null)
const { viewerUrl, viewerLoadFailed, retryViewerImage, neighborPreviews, current: viewerCurrent, openViewer, closeViewer, onViewerClosed } = useGalleryViewer({
  history: items, visible: items, previewSource: props.thumbnail, resetControls: () => {},
})
const current = computed(() => viewerCurrent.value || items.value[index.value] || props.item)
const surface = useArtworkViewerSurface({
  active: () => !closing.value, imageKey: () => selectedId.value,
  mode: () => original.value, source: props.sourceFor,
})
surface.captureOrigin(props.source, props.item.id)
useFocusTrap(dialog, () => !closing.value, { onEscape: close, initialFocus: closeButton })
onMounted(() => { select(index.value) })
watch(() => props.request, () => {
  closing.value = false; original.value = false
  surface.captureOrigin(props.source, props.item.id)
  selectedId.value = props.item.id
  select(index.value)
}, { flush: 'post' })
watch(items, value => { if (!value.some(item => item.id === selectedId.value)) close() })
function close() {
  if (closing.value) return
  closing.value = true; closeViewer()
}
function finishClose() { if (closing.value) { onViewerClosed(); emit('close') } }
function select(value: number) {
  if (closing.value || !items.value[value]) return
  selectedId.value = items.value[value].id
  void openViewer(value)
}
function onKey(event: KeyboardEvent) {
  if (event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey || event.isComposing
    || (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"]'))) return
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault(); select(index.value + (event.key === 'ArrowLeft' ? -1 : 1))
  }
}
function resume() { emit('resume', current.value); close() }
async function toggleOriginal() {
  original.value = !original.value
  await nextTick(); dialog.value?.querySelector<HTMLElement>('.zoomable-image-viewer')?.focus({ preventScroll: true })
}
</script>
<style scoped>
.saved-artwork-preview { grid-template-columns:minmax(0,1fr); }
.saved-preview-resume { position:absolute; top:18px; right:18px; z-index:var(--z-raised); }
@media (max-width:480px) { .saved-preview-resume { top:auto; bottom:18px; } }
</style>
