<template>
  <Teleport to="body">
    <dialog ref="dialog" class="art-viewer" :class="{ 'info-open': infoOpen }" data-image-transition aria-label="批量作品预览"
      @cancel.prevent="infoOpen ? closeInfo() : close()" @keydown="onKey">
      <ArtworkViewerStage :items="items" :index="index" :active="!closing" :original="original" :src="originalUrl"
        :load-failed="!!imageError" :reload="retryImage"
        :preview-src="preview || thumbUrls[current?.id || ''] || ''" :thumb-urls="neighborThumbs" :title="job => job.sceneTitle" @select="select" @close="close"
        @toggle-original="toggleOriginal" @dismiss-info="closeInfo" @interact="origin.cancel" @close-button="viewerClose = $event">
        <template #tools><button ref="infoTrigger" class="viewer-info-toggle" type="button" aria-label="作品信息" :aria-controls="infoId" :aria-expanded="infoOpen" @click="openInfo"><ArchiveIcon name="info" /></button></template>
      </ArtworkViewerStage>
      <aside :id="infoId" ref="infoPanel" class="viewer-info" :inert="infoHidden" :aria-hidden="infoHidden ? true : undefined" :aria-labelledby="`${infoId}-title`">
        <header class="viewer-info-header"><span class="viewer-kicker">批量作品</span><button ref="infoClose" class="viewer-info-close" type="button" @click="closeInfo"><ArchiveIcon name="close" />关闭信息</button></header>
        <div class="viewer-info-body">
        <h2 :id="`${infoId}-title`" class="viewer-title">{{ current?.sceneTitle }}</h2>
        <p class="viewer-meta">{{ current?.subtitle }}</p>
        <p v-if="imageError" class="viewer-meta" role="status">{{ imageError }}</p>
        <dl v-if="current" class="viewer-record"><div><dt>候选</dt><dd>{{ current.variant + 1 }}</dd></div><div><dt>Seed</dt><dd>{{ current.seed >= 0 ? current.seed : '随机' }}</dd></div></dl>
        </div>
      </aside>
    </dialog>
  </Teleport>
</template>
<script setup lang="ts">
import { computed, nextTick, onMounted, ref, useId, watch } from 'vue'
import { hasBatchArtwork, useBatchArtworkOriginal, type BatchArtworkJob } from '@/composables/generation/useBatchArtworkMedia'
import { useFluidDialog } from '@/composables/useFluidDialog'
import { useFluidSurface } from '@/composables/useFluidSurface'
import { useImageOriginTransition } from '@/composables/useImageOriginTransition'
import { useArtworkInfoDrawer } from '@/composables/useArtworkInfoDrawer'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import ArtworkViewerStage from './ArtworkViewerStage.vue'

const props = defineProps<{ jobs: readonly BatchArtworkJob[]; selectedId: string; source: HTMLImageElement | null;
  thumbUrls: Record<string, string>; pendingImage: (requestKey: string) => Blob | null }>()
const emit = defineEmits<{ close: []; select: [id: string] }>()
const items = computed(() => props.jobs.filter(hasBatchArtwork))
const selected = ref(props.selectedId), original = ref(false), closing = ref(false), infoOpen = ref(false)
const index = computed(() => Math.max(0, items.value.findIndex(job => job.id === selected.value)))
const current = computed(() => items.value[index.value])
const neighborThumbs = computed(() => Object.fromEntries(items.value.map(job => [job.id, props.thumbUrls[job.id] || ''])))
const { url: originalUrl, error: imageError, retry: retryImage } = useBatchArtworkOriginal({ current, active: computed(() => !closing.value), pendingImage: props.pendingImage })
const dialog = ref<HTMLDialogElement | null>(null)
const infoId = useId(), infoPanel = ref<HTMLElement | null>(null), infoTrigger = ref<HTMLElement | null>(null)
const infoClose = ref<HTMLElement | null>(null), viewerClose = ref<HTMLElement | null>(null)
const { compact, hidden: infoHidden, toggle: openInfo, close: closeInfo } = useArtworkInfoDrawer({
  viewer: dialog, panel: infoPanel, trigger: infoTrigger, closeButton: infoClose,
  viewerCloseButton: viewerClose, open: infoOpen, active: () => !closing.value,
})
const origin = useImageOriginTransition({ proxyPixelBudget: 1920 * 1080 })
const surface = useFluidSurface('.art-viewer')
const preview = ref(origin.capture(props.source))
const motion = useFluidDialog(dialog, {
  enter(el, done) {
    surface.enter(el, done)
    const image = el.querySelector<HTMLImageElement>('.zoomable-img')
    if (image) void origin.enter(image, el as HTMLElement)
  },
  dispose(el) { origin.cancel(); surface.dispose(el) },
})
onMounted(() => motion.open(props.source?.closest('button') ?? undefined))
function close() { if (!closing.value) { closing.value = true; motion.close(() => emit('close')) } }
function select(value: number) {
  if (!items.value[value]) return
  origin.cancel(); preview.value = ''; selected.value = items.value[value].id; emit('select', selected.value)
}
watch(() => props.selectedId, id => { selected.value = id })
watch(selected, () => { dialog.value?.querySelector('.viewer-info-body')?.scrollTo(0, 0) }, { flush: 'post' })
async function toggleOriginal() {
  origin.cancel(); original.value = !original.value
  await nextTick(); dialog.value?.querySelector<HTMLElement>('.zoomable-image-viewer')?.focus({ preventScroll: true })
}
function onKey(event: KeyboardEvent) {
  if (compact.value && infoOpen.value) return
  if (event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey || (event.target instanceof Element && event.target.closest('input'))) return
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); select(index.value + (event.key === 'ArrowLeft' ? -1 : 1)) }
}
</script>
