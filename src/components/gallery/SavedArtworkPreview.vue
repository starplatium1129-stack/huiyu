<template>
  <Teleport to="body">
    <FluidTransition :surface="surface" @after-leave="finishClose">
    <div v-show="!closing" ref="dialog" class="art-viewer saved-artwork-preview" :class="{ open: !closing }" data-image-transition
      role="dialog" aria-modal="true" aria-label="最近作品预览" :aria-hidden="closing" :inert="closing">
      <ArtworkViewerStage :items="items" :index="0" :active="!closing" :original="original" :src="viewerUrl"
        :preview-src="surface.previewSrc.value || thumbnail" :load-failed="viewerLoadFailed" :reload="retryViewerImage" :title="title"
        @close="close" @toggle-original="toggleOriginal" @close-button="closeButton = $event">
        <template #tools>
          <button class="btn btn-primary saved-preview-resume" data-viewer-chrome type="button" @click="resume"><ArchiveIcon name="spark" />{{ artworkContinueTarget(item).label }}</button>
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

const props = defineProps<{ item: ArtworkRecord; source: HTMLImageElement | null; thumbnail: string; request: number }>()
const emit = defineEmits<{ close: []; resume: [item: ArtworkRecord] }>()
const items = computed(() => [props.item])
const title = (item: ArtworkRecord) => item.sceneTitle || item.story || '未命名作品'
const original = ref(false), closing = ref(false), dialog = ref<HTMLElement | null>(null), closeButton = ref<HTMLElement | null>(null)
const { viewerUrl, viewerLoadFailed, retryViewerImage, openViewer, closeViewer, onViewerClosed } = useGalleryViewer({
  history: items, visible: items, previewSource: () => props.thumbnail, resetControls: () => {},
})
const surface = useArtworkViewerSurface({
  active: () => !closing.value, imageKey: () => props.item.id,
  mode: () => original.value, source: () => props.source,
})
surface.captureOrigin(props.source, props.item.id)
useFocusTrap(dialog, () => !closing.value, { onEscape: close, initialFocus: closeButton })
onMounted(() => { openViewer(0) })
watch(() => props.request, () => {
  closing.value = false; original.value = false
  surface.captureOrigin(props.source, props.item.id)
  openViewer(0)
}, { flush: 'post' })
function close() {
  if (closing.value) return
  closing.value = true; closeViewer()
}
function finishClose() { if (closing.value) { onViewerClosed(); emit('close') } }
function resume() { emit('resume', props.item); close() }
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
