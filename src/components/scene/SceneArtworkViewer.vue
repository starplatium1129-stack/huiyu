<template>
  <Teleport to="body">
    <FluidTransition @before-leave="leave" @after-leave="finishClose">
      <div v-show="selectedId" ref="viewerEl" class="art-viewer scene-artwork-viewer"
        :class="{ 'info-open': infoOpen, 'is-restricted': current?.restricted }" data-image-transition
        role="dialog" aria-modal="true" :aria-hidden="!selectedId" aria-label="场景观赏模式"
        @keydown="navigate" @load.capture="enter">
        <template v-if="current">
          <ArtworkViewerStage :items="displayedItems" :index="displayedIndex" :active="!!selectedId" :original="original"
            :src="current.src" :preview-src="openingPreview || current.previewSrc" :card-urls="previews"
            :title="item => item.title" @close="selectedId = null" @select="select"
            @close-button="closeButton = $event" @toggle-original="original = !original"
            @dismiss-info="infoOpen = false" @interact="cancelFlight">
            <template v-if="current.restricted" #image>
              <RuntimeImage :src="current.previewSrc" v-slot="{ image, failed }">
                <div class="scene-sensitive-art sample-r18" tabindex="0" aria-label="R18 样张，悬停或聚焦预览">
                  <img v-if="image.src && !failed" v-bind="image" :alt="current.title" decoding="async" />
                  <SensitivePreviewVeil v-if="image.src && !failed" :src="image.src" :crossorigin="image.crossorigin" />
                  <div v-if="failed || !image.src" class="viewer-fallback"><ArchiveIcon name="image" /><span>样张暂时无法读取</span></div>
                  <span v-else class="scene-sensitive-hint">R18 · 悬停或聚焦预览</span>
                </div>
              </RuntimeImage>
            </template>
            <template #tools>
              <button ref="infoToggle" class="viewer-info-toggle" data-fluid-glass type="button" aria-label="场景信息"
                :aria-controls="infoId" :aria-expanded="infoOpen" @click="infoOpen = !infoOpen"><ArchiveIcon name="info" /></button>
            </template>
          </ArtworkViewerStage>
          <aside :id="infoId" ref="infoEl" class="viewer-info" :inert="compact && !infoOpen"
            :aria-hidden="compact && !infoOpen ? 'true' : undefined" :aria-labelledby="titleId">
            <header class="viewer-info-header">
              <div class="viewer-kicker">SCENE / 场景</div>
              <button ref="infoClose" class="viewer-info-close" type="button" @click="infoOpen = false"><ArchiveIcon name="close" /><span>关闭信息</span></button>
            </header>
            <h2 :id="titleId" class="viewer-title">{{ current.title }}</h2>
            <slot name="info" :item="current" />
          </aside>
        </template>
      </div>
    </FluidTransition>
  </Teleport>
</template>

<script lang="ts">
export interface SceneArtworkPreview {
  id: string
  title: string
  src: string
  previewSrc: string
  restricted: boolean
  width?: number
  height?: number
}
</script>

<script setup lang="ts">
import { computed, nextTick, onDeactivated, onUnmounted, ref, useId, watch } from 'vue'
import { useMediaQuery, useEventListener } from '@vueuse/core'
import ArtworkViewerStage from '@/components/gallery/ArtworkViewerStage.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import FluidTransition from '@/components/visual/FluidTransition.vue'
import RuntimeImage from '@/components/visual/RuntimeImage.vue'
import SensitivePreviewVeil from '@/components/visual/SensitivePreviewVeil.vue'
import { useFocusTrap } from '@/composables/useFocusTrap'
import { useImageOriginTransition } from '@/composables/useImageOriginTransition'

const props = defineProps<{ items: SceneArtworkPreview[] }>()
const selectedId = defineModel<string | null>({ required: true })
const emit = defineEmits<{ 'after-close': [] }>()
const viewerEl = ref<HTMLElement | null>(null), closeButton = ref<HTMLElement | null>(null), infoEl = ref<HTMLElement | null>(null)
const infoToggle = ref<HTMLElement | null>(null), infoClose = ref<HTMLElement | null>(null)
const infoId = useId(), titleId = useId(), compact = useMediaQuery('(max-width: 900px)')
const infoOpen = ref(false), original = ref(false)
const displayedItems = ref<SceneArtworkPreview[]>([]), displayedIndex = ref(0)
const current = computed(() => displayedItems.value[displayedIndex.value] ?? null)
// Restricted images never enter the orbit's unfiltered neighboring frames.
const previews = computed(() => Object.fromEntries(displayedItems.value.filter(item => !item.restricted).map(item => [item.id, item.previewSrc])))
const motion = useImageOriginTransition({ proxyPixelBudget: 1920 * 1080 })
const openingPreview = ref('')
let sourceImage: HTMLImageElement | null = null, opening = false, capturedAt = 0
function capture(image: HTMLImageElement | null) {
  cancelFlight()
  sourceImage = image
  openingPreview.value = motion.capture(image)
  opening = !!openingPreview.value
  capturedAt = performance.now()
}
async function enter() {
  if (!opening || !selectedId.value || current.value?.restricted) return
  await nextTick()
  if (!opening || !selectedId.value || performance.now() - capturedAt >= 180) { opening = false; return }
  const target = viewerEl.value?.querySelector<HTMLImageElement>('.zoomable-img')
  if (!target || !viewerEl.value || !target.complete || !target.naturalWidth) return
  opening = false
  void motion.enter(target, viewerEl.value)
}
function cancelFlight() { opening = false; motion.cancel(); openingPreview.value = '' }
function leave() {
  opening = false
  const target = viewerEl.value?.querySelector<HTMLImageElement>('.zoomable-img')
  if (!current.value?.restricted && target && viewerEl.value) void motion.leave(target, viewerEl.value, sourceImage)
  else motion.cancel()
}
function finishClose() {
  if (selectedId.value) return
  cancelFlight(); sourceImage = null; displayedItems.value = []; infoOpen.value = false
  emit('after-close')
}
function select(index: number) {
  const item = displayedItems.value[index]
  if (!item || item.id === selectedId.value) return
  cancelFlight(); sourceImage = null; selectedId.value = item.id
}
function navigate(event: KeyboardEvent) {
  if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey
    || (event.target as HTMLElement).closest('input, textarea, select, .zoomable-image-viewer.is-zoomed')) return
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
  event.preventDefault(); select(displayedIndex.value + (event.key === 'ArrowLeft' ? -1 : 1))
}
watch(() => [selectedId.value, props.items] as const, ([id, items], previous) => {
  if (!id) return
  const index = items.findIndex(item => item.id === id)
  if (index < 0) { selectedId.value = null; return }
  if (!previous?.[0]) { original.value = false; infoOpen.value = false }
  displayedItems.value = items.slice(); displayedIndex.value = index
  if (infoEl.value) infoEl.value.scrollTop = 0
  void enter()
}, { immediate: true, flush: 'post' })
useFocusTrap(viewerEl, () => !!selectedId.value, { initialFocus: closeButton, onEscape: () => { selectedId.value = null } })
watch(infoOpen, async open => {
  if (!compact.value || !selectedId.value) return
  await nextTick()
  ;(open ? infoClose.value : infoToggle.value)?.focus({ preventScroll: true })
})
useEventListener(window, 'resize', cancelFlight)
useEventListener(window.visualViewport, 'resize', cancelFlight)
onDeactivated(() => { selectedId.value = null; cancelFlight() })
onUnmounted(cancelFlight)
defineExpose({ capture })
</script>

<style scoped>
.scene-sensitive-art { position:relative; display:grid; place-items:center; width:100%; height:100%; max-width:900px; min-height:0; overflow:hidden; border-radius:var(--r-md); background:var(--art-stage); --sensitive-preview-fit:contain; --sensitive-preview-position:center; }
.scene-sensitive-art > img { display:block; width:100%; height:100%; object-fit:contain; }
.scene-sensitive-art:focus-visible { outline:2px solid var(--accent); outline-offset:-2px; }
.scene-sensitive-hint { position:absolute; z-index:var(--z-raised); padding:var(--s-2) var(--s-3); border:1px solid var(--on-art-line); border-radius:var(--r-pill); background:var(--art-scrim); color:var(--on-art-primary); font-size:var(--fs-label-sm); pointer-events:none; transition:opacity var(--motion-hover) var(--ease-out); }
.scene-sensitive-art:hover .scene-sensitive-hint,.scene-sensitive-art:focus-within .scene-sensitive-hint { opacity:0; }
.scene-artwork-viewer.is-restricted :deep(.viewer-mode-switch) { display:none; }
@media (prefers-reduced-motion:reduce) { .scene-sensitive-hint { transition:none; } }
:global(:root:is([data-motion='reduce'],[data-motion='reduced'])) .scene-sensitive-hint { transition:none; }
</style>
