<template>
  <Teleport to="body">
    <dialog ref="dialog" class="art-viewer" :class="{ 'info-open': infoOpen }" data-image-transition aria-label="批量作品预览"
      @cancel.prevent="infoOpen ? closeInfo() : close()" @keydown="onKey">
      <ArtworkViewerStage :items="items" :index="index" :active="!closing" :original="original" :src="current?.resultUrl || ''"
        :preview-src="preview" :thumb-urls="images" :title="job => job.sceneTitle" @select="select" @close="close"
        @toggle-original="toggleOriginal" @dismiss-info="closeInfo" @interact="origin.cancel">
        <template #tools><button class="viewer-info-toggle" type="button" aria-label="作品信息" :aria-expanded="infoOpen" @click="openInfo"><ArchiveIcon name="info" /></button></template>
      </ArtworkViewerStage>
      <aside class="viewer-info" :inert="narrow && !infoOpen" :aria-hidden="narrow && !infoOpen ? true : undefined">
        <header class="viewer-info-header"><span class="viewer-kicker">批量作品</span><button class="viewer-info-close" type="button" @click="closeInfo"><ArchiveIcon name="close" />关闭信息</button></header>
        <h2 class="viewer-title">{{ current?.sceneTitle }}</h2>
        <p class="viewer-meta">{{ current?.subtitle }}</p>
        <dl v-if="current" class="viewer-record"><div><dt>候选</dt><dd>{{ current.variant + 1 }}</dd></div><div><dt>Seed</dt><dd>{{ current.seed >= 0 ? current.seed : '随机' }}</dd></div></dl>
      </aside>
    </dialog>
  </Teleport>
</template>
<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { useMediaQuery } from '@vueuse/core'
import type { BatchDrawJob } from '@/composables/generation/useBatchDraw'
import { useFluidDialog } from '@/composables/useFluidDialog'
import { useFluidSurface } from '@/composables/useFluidSurface'
import { useImageOriginTransition } from '@/composables/useImageOriginTransition'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import ArtworkViewerStage from './ArtworkViewerStage.vue'

type PreviewJob = Pick<BatchDrawJob, 'id' | 'resultUrl' | 'sceneTitle' | 'subtitle' | 'variant' | 'seed'>
const props = defineProps<{ jobs: readonly PreviewJob[]; selectedId: string; source: HTMLImageElement | null }>()
const emit = defineEmits<{ close: [] }>()
const items = computed(() => props.jobs.filter(job => job.resultUrl))
const selected = ref(props.selectedId), original = ref(false), closing = ref(false), infoOpen = ref(false)
const index = computed(() => Math.max(0, items.value.findIndex(job => job.id === selected.value)))
const current = computed(() => items.value[index.value])
const images = computed(() => Object.fromEntries(items.value.map(job => [job.id, job.resultUrl!])))
const dialog = ref<HTMLDialogElement | null>(null), narrow = useMediaQuery('(max-width: 900px)')
const origin = useImageOriginTransition({ proxyPixelBudget: 1920 * 1080 })
const surface = useFluidSurface('.art-viewer')
const preview = ref(origin.capture(props.source))
function sourceImage() {
  return props.source?.closest('.batch-result-grid')?.querySelector<HTMLImageElement>(`[data-preview-id="${CSS.escape(current.value?.id || '')}"] img`) ?? null
}
const motion = useFluidDialog(dialog, {
  enter(el, done) {
    surface.enter(el, done)
    const image = el.querySelector<HTMLImageElement>('.zoomable-img')
    if (image) void origin.enter(image, el as HTMLElement)
  },
  leave(el, done) {
    const image = el.querySelector<HTMLImageElement>('.zoomable-img')
    void Promise.all([new Promise<void>(resolve => surface.leave(el, resolve)), image ? origin.leave(image, el as HTMLElement, sourceImage()) : Promise.resolve()]).then(done)
  },
  dispose(el) { origin.cancel(); surface.dispose(el) },
})
onMounted(() => motion.open(props.source?.closest('button') ?? undefined))
function close() { if (!closing.value) { closing.value = true; motion.close(() => emit('close')) } }
function select(value: number) { origin.cancel(); preview.value = ''; if (items.value[value]) selected.value = items.value[value].id }
async function toggleOriginal() {
  origin.cancel(); original.value = !original.value
  await nextTick(); dialog.value?.querySelector<HTMLElement>('.zoomable-image-viewer')?.focus({ preventScroll: true })
}
async function openInfo() { infoOpen.value = true; await nextTick(); dialog.value?.querySelector<HTMLButtonElement>('.viewer-info-close')?.focus() }
function closeInfo() { if (infoOpen.value) { infoOpen.value = false; dialog.value?.querySelector<HTMLButtonElement>('.viewer-info-toggle')?.focus() } }
function onKey(event: KeyboardEvent) {
  if (event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey || (event.target instanceof Element && event.target.closest('input'))) return
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); select(index.value + (event.key === 'ArrowLeft' ? -1 : 1)) }
}
</script>
