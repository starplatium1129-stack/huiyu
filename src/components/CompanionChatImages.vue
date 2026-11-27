<template>
  <div v-if="images?.length" ref="root" class="companion-chat-images" role="group" aria-label="对话图片" tabindex="-1">
    <figure v-for="item in displayedImages" :key="identity(item)">
      <button class="companion-chat-image-open" type="button" :aria-label="`查看原图：${item.name}`" @click="openImage(item)">
        <RuntimeImage v-if="sources[identity(item)]" :src="sources[identity(item)]" v-slot="{ image, loaded }" @error="thumbnailFailed(item, $event)">
          <span class="companion-chat-image-frame" :class="{ 'is-ready': loaded }">
            <img v-bind="image" :alt="item.name" loading="lazy" decoding="async" :class="{ 'is-ready': loaded }" />
            <span v-if="!loaded" class="companion-chat-image-placeholder" aria-hidden="true"><ArchiveIcon name="image" />正在读取预览…</span>
          </span>
        </RuntimeImage>
        <span v-else class="companion-chat-image-frame">
          <span class="companion-chat-image-placeholder"><ArchiveIcon name="image" />{{ failures[identity(item)] ? '暂无缩略图 · 查看原图' : thumbnailsLoading ? '正在读取预览…' : '查看原图' }}</span>
        </span>
      </button>
      <figcaption :title="item.name">{{ item.name }}</figcaption>
      <button v-if="failures[identity(item)]" class="companion-chat-image-retry btn btn-ghost btn-sm" type="button" :disabled="thumbnailsLoading" @click="loadImages(true)">重读缩略图</button>
    </figure>
    <Teleport to="body">
      <dialog
        ref="dialog"
        class="companion-chat-image-dialog"
        :class="{ 'is-positioned': Boolean(drag.position.value), 'is-dragging': drag.isDragging.value }"
        :style="drag.dialogStyle.value"
        closedby="any"
        :aria-labelledby="opened ? dialogTitleId : undefined"
        :aria-label="opened ? undefined : '对话图片预览'"
        @close="onDialogClose"
        @cancel.prevent="closePreview"
        @click="onBackdropClick"
        @keydown.esc="onEscape"
      >
        <template v-if="opened">
          <header
            ref="dragHeader"
            class="companion-chat-image-header"
            :class="{ 'is-dragging': drag.isDragging.value }"
            @pointerdown="drag.onPointerDown"
            @pointermove="drag.onPointerMove"
            @pointerup="drag.onPointerEnd"
            @pointercancel="drag.onPointerEnd"
            @lostpointercapture="drag.onLostCapture"
            @dblclick="drag.onDoubleClick"
          >
            <button
              ref="dragHandle"
              class="companion-chat-image-drag-handle"
              type="button"
              aria-label="拖动标题栏或使用方向键移动预览窗口，按 Home 键居中"
              title="拖动标题栏或使用方向键移动，双击居中"
              @keydown="drag.onHandleKeydown"
            >
              <ArchiveIcon name="move" />
            </button>
            <h1 :id="dialogTitleId" class="companion-chat-image-title" :title="opened.name">{{ opened.name }}</h1>
            <div class="companion-chat-image-actions">
              <span v-if="originalLoading" class="companion-chat-image-pill" role="status">读取原图中…</span>
              <button
                v-if="setRoomBackground && opened"
                class="companion-chat-image-action"
                type="button"
                aria-label="设为当前角色聊天室背景"
                title="设为当前角色聊天室背景"
                @click="setRoomBackground(opened)"
              >
                <ArchiveIcon name="scene" />
              </button>
              <button
                v-if="drag.position.value"
                class="companion-chat-image-action"
                type="button"
                aria-label="窗口归位居中"
                title="归位居中"
                @click="drag.recenter"
              >
                <ArchiveIcon name="compress" />
              </button>
              <button
                class="companion-chat-image-action"
                type="button"
                aria-label="关闭图片预览"
                title="关闭 (Esc)"
                @click="closePreview"
              >
                <ArchiveIcon name="close" />
              </button>
            </div>
          </header>
          <span class="companion-chat-image-sr" aria-live="polite">{{ drag.announcement.value }}</span>
          <div ref="originalRegion" class="companion-chat-image-body" tabindex="-1" role="region" aria-label="图片阅读区">
            <div v-if="originalError" class="companion-chat-image-error" role="alert">
              <span>{{ originalError }}</span>
              <button class="btn btn-ghost btn-sm" type="button" @click="retryOriginal">重新读取原图</button>
            </div>
            <ZoomableImageViewer v-if="originalUrl || sources[identity(opened)]" :key="identity(opened)" :src="originalUrl || sources[identity(opened)]" :preview-src="sources[identity(opened)]" :alt="opened.name" @error="originalFailed" />
          </div>
        </template>
      </dialog>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, shallowRef, useId, watch } from 'vue'
import type { CompanionChatImage } from '@/types/companionDrawing'
import { companionImageKey as identity, useCompanionImageMedia } from '@/composables/chat/useCompanionImageMedia'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import RuntimeImage from '@/components/visual/RuntimeImage.vue'
import ZoomableImageViewer from '@/components/visual/ZoomableImageViewer.vue'
import { isBackdropClick, useFluidDialog } from '@/composables/useFluidDialog'
import { useDraggableDialog } from '@/composables/useDraggableDialog'

const dialogTitleId = useId()

const props = defineProps<{ images?: CompanionChatImage[] }>()
const setRoomBackground = inject<((image: CompanionChatImage) => void) | null>('huiyu-set-room-bg', null)
const root = ref<HTMLElement>(), dialog = ref<HTMLDialogElement | null>(null)
const dragHeader = ref<HTMLElement | null>(null), dragHandle = ref<HTMLButtonElement | null>(null)
const modal = useFluidDialog(dialog)
const drag = useDraggableDialog(dialog, dragHeader, dragHandle)
const originalRegion = ref<HTMLElement>()
const opened = shallowRef<CompanionChatImage | null>(null)
const displayedImages = computed(() => [...new Map((props.images || []).map(item => [identity(item), item])).values()])
let observer: IntersectionObserver | undefined, visible = false, activeView = true, previewRevision = 0
const { sources, failures, thumbnailsLoading, originalUrl, originalLoading, originalError,
  loadThumbnails, rejectThumbnail, loadOriginal, releaseOriginal, originalFailed, release } = useCompanionImageMedia(() => activeView, onSessionChange)

function closePreview() {
  previewRevision++; opened.value = null; releaseOriginal()
  modal.close()
  drag.reset()
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
  drag.reset()
  const revision = ++previewRevision
  const source = document.activeElement as HTMLElement | null
  const selection = { ...image }; opened.value = selection
  await nextTick()
  if (!activeView || revision !== previewRevision || !opened.value || identity(opened.value) !== identity(selection) || !dialog.value) return
  if (!dialog.value.open) modal.open(source)
  void loadOriginal(selection)
}
function onBackdropClick(event: MouseEvent) {
  if (drag.shouldIgnoreBackdropClick()) return
  if (isBackdropClick(event, dialog.value)) closePreview()
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
.companion-chat-images { display:flex; flex-wrap:wrap; align-items:flex-start; gap:var(--s-2); margin-top:var(--s-2); }
.companion-chat-images figure { display:inline-grid; grid-template-columns:auto; flex:0 1 auto; width:fit-content; max-width:100%; margin:0; padding:0; border:0; background:transparent; }
.companion-chat-image-open { position:relative; display:block; width:fit-content; max-width:100%; padding:0; overflow:clip; border:1px solid var(--border-soft); border-radius:var(--r-md); background:transparent; box-shadow:var(--shadow-sm); cursor:var(--cursor-zoom-in, zoom-in); --control-feedback-zoom:1.025; }
.companion-chat-image-frame { position:relative; display:block; width:min(220px,100%); aspect-ratio:4 / 3; background:var(--bg-elevated); }
.companion-chat-image-frame.is-ready { width:fit-content; max-width:100%; aspect-ratio:auto; background:transparent; }
.companion-chat-image-frame img { position:absolute; inset:0; display:block; width:100%; height:100%; object-fit:contain; opacity:0; transition:opacity var(--motion-hover) var(--ease-out), transform var(--control-feedback-duration,var(--motion-art-hover)) var(--spring-soft); }
.companion-chat-image-frame img.is-ready { position:static; width:auto; height:auto; max-width:min(320px,100%); max-height:360px; opacity:1; }
@media (prefers-reduced-motion:reduce) { :root:not([data-motion='full']) .companion-chat-image-frame img { transition:none; } }
:root:is([data-motion='reduce'],[data-motion='reduced']) .companion-chat-image-frame img { transition:none; }
.companion-chat-image-placeholder { position:absolute; inset:0; box-sizing:border-box; display:flex; align-items:center; justify-content:center; gap:var(--s-2); padding:var(--s-4) var(--s-2); color:var(--text-secondary); font-size:var(--fs-label-sm); }
.companion-chat-image-placeholder .archive-icon { flex-shrink:0; width:20px; height:20px; }
.companion-chat-images figcaption { inline-size:0; min-inline-size:100%; overflow:hidden; margin-top:var(--s-1); padding-inline:2px; color:var(--text-secondary); font-size:var(--fs-label-xs); line-height:var(--lh-body); text-overflow:ellipsis; white-space:nowrap; }
.companion-chat-image-retry { margin-top:var(--s-2); max-width:100%; white-space:normal; }
.companion-chat-images:focus-visible,.companion-chat-image-open:focus-visible,.companion-chat-image-retry:focus-visible { outline:none; box-shadow:var(--focus-shadow); }

.companion-chat-image-dialog {
  --dialog-accent: var(--character-accent, var(--accent));
  position: fixed;
  inset: var(--desktop-chrome-height, 0px) 0 0;
  margin: auto;
  box-sizing: border-box;
  width: min(820px, calc(100dvw - 2 * var(--s-4)));
  max-width: calc(100dvw - 2 * var(--s-4));
  height: min(760px, calc(100dvh - var(--desktop-chrome-height, 0px) - 2 * var(--s-4)));
  max-height: calc(100dvh - var(--desktop-chrome-height, 0px) - 2 * var(--s-4));
  overflow: hidden;
  padding: 0;
  border: 1px solid var(--border-strong);
  border-radius: var(--r-xl);
  background: var(--bg-surface);
  color: var(--text-primary);
  box-shadow: inset 0 1px 0 var(--glass-highlight), var(--shadow-lg);
}
.companion-chat-image-dialog.is-positioned { inset: auto; margin: 0; }
.companion-chat-image-dialog.is-dragging { will-change: transform; }
.companion-chat-image-dialog[open] { display: grid; grid-template-rows: auto minmax(0, 1fr); }
.companion-chat-image-dialog:modal { overscroll-behavior: contain; }
.companion-chat-image-dialog::backdrop {
  overflow: hidden;
  overscroll-behavior: contain;
  background: var(--art-backdrop);
  -webkit-backdrop-filter: var(--glass-disabled, blur(8px));
  backdrop-filter: var(--glass-disabled, blur(8px));
}
:root:not([data-theme-style='terraria']) .companion-chat-image-dialog::before {
  content: '';
  position: absolute;
  inset: 0 0 auto;
  height: 2px;
  z-index: var(--z-raised);
  pointer-events: none;
  background: linear-gradient(
    90deg,
    transparent 0%,
    color-mix(in srgb, var(--dialog-accent) 70%, transparent) 18%,
    var(--dialog-accent) 50%,
    color-mix(in srgb, var(--dialog-accent) 70%, transparent) 82%,
    transparent 100%
  );
}
.companion-chat-image-header {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  min-width: 0;
  padding: var(--s-2) var(--s-3);
  border-bottom: 1px solid var(--border-soft);
  background: var(--bg-elevated);
  cursor: grab;
  touch-action: none;
  -webkit-user-select: none;
  user-select: none;
}
.companion-chat-image-header.is-dragging { cursor: grabbing; }
.companion-chat-image-drag-handle,
.companion-chat-image-action {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: var(--control-height-sm);
  height: var(--control-height-sm);
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: background-color var(--motion-hover) var(--ease-out), border-color var(--motion-hover) var(--ease-out), color var(--motion-hover) var(--ease-out);
}
.companion-chat-image-drag-handle { cursor: grab; }
.companion-chat-image-header.is-dragging .companion-chat-image-drag-handle { cursor: grabbing; }
@media (hover: hover) and (pointer: fine) {
  .companion-chat-image-drag-handle:hover,
  .companion-chat-image-action:hover {
    border-color: var(--border-soft);
    background: var(--bg-hover);
    color: var(--text-primary);
  }
}
.companion-chat-image-drag-handle:focus-visible,
.companion-chat-image-action:focus-visible { outline: none; box-shadow: var(--focus-shadow); }
.companion-chat-image-title {
  flex: 1 1 auto;
  min-width: 0;
  margin: 0;
  overflow: hidden;
  color: var(--text-primary);
  font: 500 var(--fs-label)/var(--lh-label) var(--font-sans);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.companion-chat-image-actions { display: flex; align-items: center; flex-shrink: 0; gap: var(--s-1); }
.companion-chat-image-pill {
  padding: 2px var(--s-2);
  border: 1px solid var(--border-soft);
  border-radius: var(--r-pill);
  background: var(--bg-surface);
  color: var(--text-secondary);
  font-size: var(--fs-label-xs);
  white-space: nowrap;
}
.companion-chat-image-sr {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}
.companion-chat-image-body {
  position: relative;
  min-height: 0;
  display: grid;
  grid-template-rows: minmax(0, 1fr);
  overflow: hidden;
  padding: var(--s-3);
  background: var(--bg-base);
}
.companion-chat-image-body:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--focus-color); }
.companion-chat-image-error {
  position: absolute;
  inset: var(--s-3) var(--s-3) auto;
  z-index: var(--z-raised);
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--s-2);
  padding: var(--s-2) var(--s-3);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
  background: var(--bg-surface);
  color: var(--text-primary);
  font-size: var(--fs-label-sm);
  box-shadow: var(--shadow-md);
}
.companion-chat-image-dialog :deep(.zoomable-image-viewer) { min-width: 0; min-height: 0; height: 100%; border-radius: var(--r-md); }
.companion-chat-image-dialog :deep(.zoomable-img) { max-height: 100%; }

:root[data-theme='light'] .companion-chat-image-dialog {
  border-color: var(--border-soft);
  box-shadow: var(--shadow-glass-md);
}
:root[data-reduced-glass='true'] .companion-chat-image-dialog::backdrop {
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
}
@media (prefers-reduced-transparency: reduce), (prefers-contrast: more) {
  .companion-chat-image-dialog::backdrop { -webkit-backdrop-filter: none; backdrop-filter: none; }
}
@media (pointer: coarse) {
  .companion-chat-image-drag-handle,
  .companion-chat-image-action { width: 40px; height: 40px; }
}
@media (forced-colors: active) {
  .companion-chat-image-dialog { background: Canvas; color: CanvasText; border: 1px solid CanvasText; box-shadow: none; }
  .companion-chat-image-dialog::before { display: none; }
  .companion-chat-image-dialog::backdrop { -webkit-backdrop-filter: none; backdrop-filter: none; }
}
</style>
