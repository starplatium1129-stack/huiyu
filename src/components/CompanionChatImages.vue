<template>
  <div v-if="images?.length" ref="root" class="companion-chat-images" role="group" aria-label="对话图片" tabindex="-1">
    <figure v-for="item in displayedImages" :key="identity(item)">
      <button class="companion-chat-image-open" type="button" :aria-label="`查看原图：${item.name}`" @click="openImage(item)">
        <RuntimeImage v-if="sources[identity(item)]" :src="sources[identity(item)]" v-slot="{ image, loaded }" @error="thumbnailFailed(item, $event)">
          <img v-bind="image" :alt="item.name" loading="lazy" decoding="async" :class="{ 'is-ready': loaded }" />
          <span v-if="!loaded" class="companion-chat-image-placeholder" aria-hidden="true"><ArchiveIcon name="image" />正在读取预览…</span>
        </RuntimeImage>
        <span v-else class="companion-chat-image-placeholder"><ArchiveIcon name="image" />{{ failures[identity(item)] ? '暂无缩略图 · 查看原图' : thumbnailsLoading ? '正在读取预览…' : '查看原图' }}</span>
      </button>
      <figcaption>{{ item.name }}</figcaption>
      <button v-if="failures[identity(item)]" class="companion-chat-image-retry" type="button" :disabled="thumbnailsLoading" @click="loadImages(true)">重读缩略图</button>
    </figure>
    <Teleport to="body">
      <dialog ref="dialog" class="companion-chat-image-dialog" aria-label="对话图片预览" @close="onDialogClose" @click="onBackdropClick" @keydown.esc="onEscape">
        <template v-if="opened">
          <header><span>{{ opened.name }}</span><button type="button" aria-label="关闭图片预览" @click="closePreview"><ArchiveIcon name="close" /></button></header>
          <div ref="originalRegion" class="companion-chat-image-body" tabindex="-1" role="region" aria-label="图片阅读区">
            <div class="companion-chat-image-feedback">
              <p v-if="originalLoading" role="status">正在读取原图…</p>
              <template v-else-if="originalError"><p role="alert">{{ originalError }}</p><button class="btn btn-ghost btn-sm" type="button" @click="retryOriginal">重新读取原图</button></template>
              <p v-else-if="originalUrl" role="status">原图已就绪，可缩放查看。</p>
            </div>
            <ZoomableImageViewer v-if="originalUrl || sources[identity(opened)]" :key="identity(opened)" :src="originalUrl || sources[identity(opened)]" :preview-src="sources[identity(opened)]" :alt="opened.name" @error="originalFailed" />
          </div>
        </template>
      </dialog>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, shallowRef, watch } from 'vue'
import type { CompanionChatImage } from '@/types/companionDrawing'
import { companionImageKey as identity, useCompanionImageMedia } from '@/composables/chat/useCompanionImageMedia'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import RuntimeImage from '@/components/visual/RuntimeImage.vue'
import ZoomableImageViewer from '@/components/visual/ZoomableImageViewer.vue'
import { prepareNativeModal } from '@/composables/useFocusTrap'

const props = defineProps<{ images?: CompanionChatImage[] }>()
const root = ref<HTMLElement>(), dialog = ref<HTMLDialogElement>()
const originalRegion = ref<HTMLElement>()
const opened = shallowRef<CompanionChatImage | null>(null)
const displayedImages = computed(() => [...new Map((props.images || []).map(item => [identity(item), item])).values()])
let observer: IntersectionObserver | undefined, visible = false, activeView = true, previewRevision = 0
const { sources, failures, thumbnailsLoading, originalUrl, originalLoading, originalError,
  loadThumbnails, rejectThumbnail, loadOriginal, releaseOriginal, originalFailed, release } = useCompanionImageMedia(() => activeView, onSessionChange)

function closePreview() {
  previewRevision++; opened.value = null; releaseOriginal()
  if (dialog.value?.open) dialog.value.close()
}
function onDialogClose() {
  // Native close events are queued; an earlier close must not cancel a reopened image.
  if (!dialog.value?.open) closePreview()
}
function onEscape(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229) return
  event.preventDefault(); event.stopPropagation(); closePreview()
}
function loadImages(retry = false) {
  if (!visible || !activeView) return
  if (retry) root.value?.focus({ preventScroll: true })
  void loadThumbnails(displayedImages.value, retry)
}
function retryOriginal() { originalRegion.value?.focus({ preventScroll: true }); if (opened.value) void loadOriginal(opened.value) }
function onSessionChange(ready: boolean) {
  closePreview()
  if (ready) loadImages()
}
function thumbnailFailed(image: CompanionChatImage, event: Event) {
  if (!(event.target instanceof HTMLImageElement) || !root.value?.contains(event.target) || event.target.getAttribute('src') !== sources.value[identity(image)]) return
  rejectThumbnail(image)
}
async function openImage(image: CompanionChatImage) {
  if (!activeView || (opened.value && identity(opened.value) === identity(image) && (originalLoading.value || originalUrl.value))) return
  releaseOriginal()
  const revision = ++previewRevision
  const selection = { ...image }; opened.value = selection
  await nextTick()
  if (!activeView || revision !== previewRevision || !opened.value || identity(opened.value) !== identity(selection) || !dialog.value) return
  if (!dialog.value.open) {
    prepareNativeModal(dialog.value)
    dialog.value.showModal()
  }
  void loadOriginal(selection)
}
function onBackdropClick(event: MouseEvent) {
  if (event.target !== dialog.value) return
  const bounds = dialog.value.getBoundingClientRect()
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closePreview()
}
watch(() => props.images, () => {
  if (opened.value) {
    const retained = displayedImages.value.find(image => identity(image) === identity(opened.value!))
    if (retained) opened.value = { ...retained }
    else closePreview()
  }
  loadImages()
}, { deep: true })
watch(root, element => { if (element && !visible) observer?.observe(element) })
onMounted(() => {
  observer = new IntersectionObserver(entries => {
    if (!activeView || !entries.some(entry => entry.isIntersecting)) return
    visible = true; observer?.disconnect(); loadImages()
  }, { rootMargin: '120px' })
  if (root.value) observer.observe(root.value)
})
onDeactivated(() => { activeView = false; visible = false; observer?.disconnect(); closePreview(); release() })
onActivated(() => { activeView = true; if (root.value && !visible) observer?.observe(root.value) })
onBeforeUnmount(() => { activeView = false; observer?.disconnect(); visible = false; closePreview(); release() })
</script>

<style scoped>
.companion-chat-images { display:flex; flex-wrap:wrap; gap:10px; margin-top:10px; }
.companion-chat-images figure { flex:1; min-width:140px; max-width:300px; margin:0; padding:8px; border:1px solid var(--border-soft); border-radius:12px; background:var(--bg-elevated); }
.companion-chat-image-open { position:relative; display:block; width:100%; aspect-ratio:4/3; padding:0; overflow:hidden; border:0; border-radius:8px; background:var(--bg-deep); cursor:zoom-in; }
.companion-chat-image-open img { position:absolute; inset:0; display:block; width:100%; height:100%; object-fit:contain; opacity:0; transition:opacity var(--motion-hover) var(--ease-out); }
.companion-chat-image-open img.is-ready { opacity:1; }
@media (prefers-reduced-motion:reduce) { :root:not([data-motion='full']) .companion-chat-image-open img { transition:none; } }
:root:is([data-motion='reduce'],[data-motion='reduced']) .companion-chat-image-open img { transition:none; }
.companion-chat-image-placeholder { position:absolute; inset:0; box-sizing:border-box; display:flex; align-items:center; justify-content:center; gap:var(--s-2); padding:var(--s-4) var(--s-2); color:var(--text-secondary); font-size:var(--fs-label-sm); }
.companion-chat-image-placeholder .archive-icon { flex-shrink:0; width:20px; height:20px; }
.companion-chat-images p { margin:0; padding:24px 8px; color:var(--text-secondary); font-size:12px; }
.companion-chat-images figcaption { overflow:hidden; margin-top:6px; color:var(--text-secondary); font-size:11px; line-height:1.5; text-overflow:ellipsis; white-space:nowrap; }
.companion-chat-image-retry { min-height:28px; margin-top:5px; padding:3px 6px; border:1px solid var(--border-soft); border-radius:6px; background:var(--bg-surface); color:var(--text-primary); }
.companion-chat-image-retry:disabled { color:var(--text-disabled); cursor:default; }
.companion-chat-images:focus-visible,.companion-chat-image-open:focus-visible,.companion-chat-image-retry:focus-visible { outline:none; box-shadow:var(--focus-shadow); }
.companion-chat-image-dialog { box-sizing:border-box; width:min(860px,calc(100vw - 24px)); height:min(760px,calc(100dvh - 24px)); overflow:hidden; padding:12px; border:1px solid var(--border-soft); border-radius:16px; background:var(--bg-surface); color:var(--text-primary); }
.companion-chat-image-dialog[open] { display:grid; grid-template-rows:auto minmax(0,1fr); }
.companion-chat-image-dialog::backdrop { background:var(--art-scrim); }
.companion-chat-image-dialog header { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:10px; font-size:13px; }
.companion-chat-image-dialog header span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.companion-chat-image-dialog header button { display:grid; place-items:center; flex-shrink:0; width:32px; height:32px; padding:0; border:1px solid var(--border-soft); border-radius:8px; background:var(--bg-elevated); color:var(--text-primary); cursor:pointer; }
.companion-chat-image-dialog header button:focus-visible { outline:none; box-shadow:var(--focus-shadow); }
.companion-chat-image-body { min-height:0; display:grid; grid-template-rows:72px minmax(0,1fr); overflow:hidden; }
.companion-chat-image-body:focus-visible { outline:none; box-shadow:inset 0 0 0 2px var(--focus-color); }
.companion-chat-image-feedback { display:flex; align-items:center; flex-wrap:wrap; gap:var(--s-2); min-height:0; overflow:auto; }
.companion-chat-image-feedback p { margin:0; padding:var(--s-2) 0; }
.companion-chat-image-dialog :deep(.zoomable-image-viewer) { min-width:0; min-height:0; height:100%; }
.companion-chat-image-dialog :deep(.zoomable-img) { max-height:100%; }
</style>
