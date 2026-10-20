<template>
  <Teleport to="body">
    <FluidTransition :surface="surface" @before-leave="leave" @after-leave="finishClose">
    <div v-show="!closing" ref="dialog" class="art-viewer saved-artwork-preview" :class="{ open: !closing }" data-image-transition
      role="dialog" aria-modal="true" aria-label="最近作品预览" :aria-hidden="closing" :inert="closing" @load.capture="enter">
      <ArtworkViewerStage :items="items" :index="0" :active="!closing" :original="original" :src="viewerUrl"
        :preview-src="preview" :load-failed="viewerLoadFailed" :reload="retryViewerImage" :title="title"
        @close="close" @toggle-original="toggleOriginal" @interact="origin.cancel" @close-button="closeButton = $event">
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
import { useImageOriginTransition } from '@/composables/useImageOriginTransition'
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
const origin = useImageOriginTransition({ proxyPixelBudget: 1920 * 1080 })
const preview = ref(origin.capture(props.source) || props.thumbnail)
const surface = useArtworkViewerSurface()
useFocusTrap(dialog, () => !closing.value, { onEscape: close, initialFocus: closeButton })
let entered = false
function enter() {
  if (entered || closing.value) return
  const image = dialog.value?.querySelector<HTMLImageElement>('.zoomable-img')
  if (image?.complete && image.naturalWidth && dialog.value) { entered = true; void origin.enter(image, dialog.value) }
}
function leave() {
  const image = dialog.value?.querySelector<HTMLImageElement>('.zoomable-img')
  if (image && dialog.value) void origin.leave(image, dialog.value, props.source)
}
onMounted(() => { openViewer(0); void nextTick(enter) })
watch(() => props.request, () => {
  closing.value = false; entered = false; original.value = false
  preview.value = origin.capture(props.source) || props.thumbnail
  openViewer(0); void nextTick(enter)
}, { flush: 'post' })
function close() {
  if (closing.value) return
  closing.value = true; closeViewer()
}
function finishClose() { if (closing.value) { origin.cancel(); onViewerClosed(); emit('close') } }
function resume() { emit('resume', props.item); close() }
async function toggleOriginal() {
  origin.cancel(); original.value = !original.value
  await nextTick(); dialog.value?.querySelector<HTMLElement>('.zoomable-image-viewer')?.focus({ preventScroll: true })
}
</script>
<style scoped>
.saved-artwork-preview { grid-template-columns:minmax(0,1fr); }
.saved-preview-resume { position:absolute; top:18px; right:18px; z-index:var(--z-raised); }
@media (max-width:480px) { .saved-preview-resume { top:auto; bottom:18px; } }
</style>
