<template>
  <div v-if="images?.length" ref="root" class="companion-chat-images" aria-label="对话图片">
    <figure v-for="item in displayedImages" :key="identity(item)">
      <button v-if="sources[identity(item)]" class="companion-chat-image-open" type="button" :aria-label="`查看图片：${item.name}`" @click="openImage(item)">
        <img :src="sources[identity(item)]" :alt="item.name" loading="lazy" decoding="async" />
      </button>
      <p v-else role="status">{{ failures[identity(item)] ? '图片暂时无法读取' : '正在读取图片…' }}</p>
      <figcaption>{{ item.name }}</figcaption>
      <button v-if="failures[identity(item)]" class="companion-chat-image-retry" type="button" @click="loadImages">重新读取</button>
    </figure>
    <Teleport to="body">
      <dialog ref="dialog" class="companion-chat-image-dialog" aria-label="对话图片预览" @close="opened = null" @click="onBackdropClick" @keydown.esc.prevent.stop="dialog?.close()">
        <template v-if="opened">
          <header><span>{{ opened.name }}</span><button type="button" aria-label="关闭图片预览" @click="dialog?.close()"><ArchiveIcon name="close" /></button></header>
          <ZoomableImageViewer :src="sources[identity(opened)] || ''" :alt="opened.name" />
        </template>
      </dialog>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onActivated, onDeactivated, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import type { CompanionChatImage } from '@/types/companionDrawing'
import { artworkRepository } from '@/storage/artworkRepository'
import { fetchRuntimeResult, isRuntimeResultPath } from '@/api/runtimeTasks'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import ZoomableImageViewer from '@/components/visual/ZoomableImageViewer.vue'
import { prepareNativeModal } from '@/composables/useFocusTrap'

const props = defineProps<{ images?: CompanionChatImage[] }>()
const root = ref<HTMLElement>(), dialog = ref<HTMLDialogElement>()
const sources = shallowRef<Record<string, string>>({}), failures = shallowRef<Record<string, boolean>>({})
const opened = shallowRef<CompanionChatImage | null>(null)
const identity = (image: CompanionChatImage) => image.imageId || image.path
const displayedImages = computed(() => [...new Map((props.images || []).map(item => [identity(item), item])).values()])
let controller: AbortController | null = null, observer: IntersectionObserver | undefined, visible = false, activeView = true

function releaseImages() {
  controller?.abort(); controller = null
  dialog.value?.close(); opened.value = null
  Object.values(sources.value).forEach(url => URL.revokeObjectURL(url))
  sources.value = {}; failures.value = {}
}
async function loadImages() {
  releaseImages()
  if (!visible || !activeView) return
  const active = new AbortController(); controller = active
  const images = displayedImages.value.slice()
  await Promise.all(images.map(async item => {
    const key = identity(item)
    try {
      let blob = item.imageId || /^(?:image-|img_)/.test(item.path)
        ? await artworkRepository.getImage(item.imageId || item.path, active.signal)
        : isRuntimeResultPath(item.path) ? await fetchRuntimeResult(item.path, active.signal) : null
      if (!blob && item.imageId && isRuntimeResultPath(item.path)) blob = await fetchRuntimeResult(item.path, active.signal)
      if (active.signal.aborted) return
      if (!blob?.size || !blob.type.startsWith('image/')) throw new Error('图片无法读取')
      sources.value = { ...sources.value, [key]: URL.createObjectURL(blob) }
    } catch {
      if (!active.signal.aborted) failures.value = { ...failures.value, [key]: true }
    }
  }))
}
async function openImage(image: CompanionChatImage) {
  opened.value = image
  await nextTick()
  if (opened.value === image && dialog.value && !dialog.value.open) {
    prepareNativeModal(dialog.value)
    dialog.value.showModal()
  }
}
function onBackdropClick(event: MouseEvent) {
  if (event.target !== dialog.value) return
  const bounds = dialog.value.getBoundingClientRect()
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.value.close()
}
watch(() => props.images, () => { void loadImages() }, { deep: true })
watch(root, element => { if (element && !visible) observer?.observe(element) })
onMounted(() => {
  observer = new IntersectionObserver(entries => {
    if (!activeView || !entries.some(entry => entry.isIntersecting)) return
    visible = true; observer?.disconnect(); void loadImages()
  }, { rootMargin: '120px' })
  if (root.value) observer.observe(root.value)
})
onDeactivated(() => { activeView = false; visible = false; observer?.disconnect(); releaseImages() })
onActivated(() => { activeView = true; if (root.value && !visible) observer?.observe(root.value) })
onUnmounted(() => { observer?.disconnect(); visible = false; releaseImages() })
</script>

<style scoped>
.companion-chat-images { display:flex; flex-wrap:wrap; gap:10px; margin-top:10px; }
.companion-chat-images figure { flex:1; min-width:140px; max-width:300px; margin:0; padding:8px; border:1px solid var(--border-soft); border-radius:12px; background:var(--bg-elevated); }
.companion-chat-image-open { display:block; width:100%; padding:0; overflow:hidden; border:0; border-radius:8px; background:transparent; cursor:zoom-in; }
.companion-chat-image-open img { display:block; width:100%; max-height:220px; object-fit:contain; }
.companion-chat-images p { margin:0; padding:24px 8px; color:var(--text-secondary); font-size:12px; }
.companion-chat-images figcaption { overflow:hidden; margin-top:6px; color:var(--text-secondary); font-size:11px; line-height:1.5; text-overflow:ellipsis; white-space:nowrap; }
.companion-chat-image-retry { min-height:28px; margin-top:5px; padding:3px 6px; border:1px solid var(--border-soft); border-radius:6px; background:var(--bg-surface); color:var(--text-primary); }
.companion-chat-image-open:focus-visible,.companion-chat-image-retry:focus-visible { outline:none; box-shadow:var(--focus-shadow); }
.companion-chat-image-dialog { box-sizing:border-box; width:min(860px,calc(100vw - 24px)); max-height:calc(100vh - 24px); overflow:auto; padding:12px; border:1px solid var(--border-soft); border-radius:16px; background:var(--bg-surface); color:var(--text-primary); }
.companion-chat-image-dialog::backdrop { background:var(--art-scrim); }
.companion-chat-image-dialog header { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:10px; font-size:13px; }
.companion-chat-image-dialog header span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.companion-chat-image-dialog header button { display:grid; place-items:center; flex-shrink:0; width:32px; height:32px; padding:0; border:1px solid var(--border-soft); border-radius:8px; background:var(--bg-elevated); color:var(--text-primary); cursor:pointer; }
.companion-chat-image-dialog header button:focus-visible { outline:none; box-shadow:var(--focus-shadow); }
.companion-chat-image-dialog :deep(.zoomable-image-viewer) { min-height:min(280px,55vh); height:min(680px,calc(100vh - 100px)); }
.companion-chat-image-dialog :deep(.zoomable-img) { max-height:calc(100vh - 116px); }
</style>
