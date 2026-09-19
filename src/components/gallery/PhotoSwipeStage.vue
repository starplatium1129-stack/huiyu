<template>
  <div ref="host" class="photoswipe-stage" aria-label="手势观画">
    <div class="photoswipe-tools">
      <button class="btn btn-ghost" type="button" aria-label="缩放作品" @click="toggleZoom"><ArchiveIcon name="search" /> 缩放</button>
      <span>双指或滚轮缩放 · 滑动切图</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from 'vue'
import PhotoSwipe from 'photoswipe'
import 'photoswipe/style.css'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { imgGet } from '@/composables/useImageStore'
import { safeImageUrl } from '@/composables/gallery/galleryHelpers'
import type { ArtworkRecord } from '@/types/artwork'

const props = defineProps<{ items: ArtworkRecord[]; index: number }>()
const emit = defineEmits<{ change: [index: number]; error: [] }>()
const host = ref<HTMLElement | null>(null)
let viewer: PhotoSwipe | null = null
let revision = 0
let resize: ResizeObserver | null = null
const urls = new Map<number, string>()
// Only URLs created here may be revoked; image_url can be borrowed from Gallery.
const ownedUrls = new Set<string>()
const pending = new Set<number>()
const decoding = new Set<HTMLImageElement>()
function toggleZoom() { viewer?.toggleZoom() }

function releaseUrl(url: string) {
  if (ownedUrls.delete(url)) URL.revokeObjectURL(url)
}
function dispose() {
  revision++
  resize?.disconnect(); resize = null
  const previous = viewer; viewer = null
  try { previous?.destroy() } catch { /* finish cleanup even after partial initialization */ }
  for (const image of decoding) image.removeAttribute('src')
  decoding.clear()
  for (const url of ownedUrls) releaseUrl(url)
  urls.clear(); pending.clear()
}
function start() {
  dispose()
  const element = host.value
  if (!element || !props.items.length || props.index < 0) return
  const token = revision
  const items = [...props.items]
  const data = items.map(item => ({ type: 'image', src: '', width: Number(item.width) || 832, height: Number(item.height) || 1216, alt: item.sceneTitle || '作品' }))
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  let instance: PhotoSwipe
  try { instance = new PhotoSwipe({
    dataSource: data, index: props.index, appendToEl: element,
    getViewportSizeFn: () => ({ x: element.clientWidth, y: element.clientHeight }),
    // The Gallery dialog owns focus, keyboard navigation and body scroll.
    trapFocus: false, returnFocus: false, escKey: false, arrowKeys: false,
    close: false, zoom: false, counter: false, arrowPrev: false, arrowNext: false,
    showAnimationDuration: 0, hideAnimationDuration: 0, zoomAnimationDuration: reduced ? 0 : 200,
    wheelToZoom: true, loop: false, preload: [1, 1], bgOpacity: 0,
    pinchToClose: false, closeOnVerticalDrag: false, clickToCloseNonZoomable: false,
    imageClickAction: 'zoom', bgClickAction: false, tapAction: false, doubleTapAction: 'zoom',
    errorMsg: '图片暂时无法读取，可返回原查看器重试',
  }) } catch { dispose(); emit('error'); return }
  viewer = instance
  instance.on('keydown', event => event.preventDefault())
  instance.on('change', () => {
    if (revision !== token) return
    if (instance.currIndex !== props.index) emit('change', instance.currIndex)
    // Only current and neighboring decoded images survive long browsing sessions.
    for (const [index, url] of urls) {
      if (Math.abs(index - instance.currIndex) <= 2) continue
      instance.contentLoader.getContentByIndex(index)?.destroy()
      instance.contentLoader.removeByIndex(index)
      data[index].src = ''
      releaseUrl(url)
      urls.delete(index)
    }
  })
  instance.on('contentLoad', event => {
    if (revision !== token) return
    const index = event.content.index
    if (data[index]?.src) return
    event.preventDefault()
    if (pending.has(index)) return
    pending.add(index)
    void (async () => {
      let url = ''
      try {
        const item = items[index]
        const blob = item.image_id ? await imgGet(item.image_id) : null
        if (revision !== token) return
        url = blob ? URL.createObjectURL(blob) : safeImageUrl(item.image_url) || (item.image_data?.startsWith('data:image/') ? item.image_data : '')
        if (blob) ownedUrls.add(url)
        if (!url) throw new Error('missing image')
        urls.set(index, url)
        const image = new Image()
        decoding.add(image)
        image.src = url
        try { await image.decode() } finally { decoding.delete(image) }
        if (revision !== token || Math.abs(index - instance.currIndex) > 2) {
          releaseUrl(url)
          if (revision === token && urls.get(index) === url) urls.delete(index)
          return
        }
        urls.set(index, url)
        Object.assign(data[index], { src: url, width: image.naturalWidth, height: image.naturalHeight })
        instance.refreshSlideContent(index)
      } catch {
        releaseUrl(url)
        if (revision === token && urls.get(index) === url) urls.delete(index)
        if (revision === token) event.content.onError()
      } finally { if (revision === token) pending.delete(index) }
    })()
  })
  instance.on('afterInit', () => {
    if (revision !== token) return
    instance.element?.removeAttribute('role')
    instance.element?.removeAttribute('aria-modal')
    const offset = element.getBoundingClientRect()
    instance.setScrollOffset(offset.left + window.scrollX, offset.top + window.scrollY)
  })
  try {
    instance.init()
    resize = new ResizeObserver(() => {
      if (revision !== token) return
      instance.updateSize(true)
      const offset = element.getBoundingClientRect()
      instance.setScrollOffset(offset.left + window.scrollX, offset.top + window.scrollY)
    })
    resize.observe(element)
  } catch { dispose(); emit('error') }
}
watch(() => props.index, index => { if (index >= 0 && viewer && viewer.currIndex !== index) viewer.goTo(index) })
watch(() => props.items.map(item => item.id).join(','), start)
onMounted(start)
onBeforeUnmount(dispose)
</script>

<style scoped>
.photoswipe-stage { position: absolute; inset: 60px 48px; }
.photoswipe-stage :deep(.pswp) { position: absolute; z-index: 0; }
.photoswipe-stage :deep(.pswp__error-msg) { color: var(--on-art-primary); }
.photoswipe-stage :deep(.pswp__top-bar) { display: none; }
.photoswipe-tools { position: absolute; z-index: 1; inset: auto 0 0; display: flex; justify-content: center; align-items: center; flex-wrap: wrap; gap: var(--s-2); pointer-events: none; color: var(--on-art-secondary); font-size: var(--fs-label-xs); }
.photoswipe-tools button { pointer-events: auto; background: var(--art-scrim); color: var(--on-art-primary); }
.photoswipe-tools span { background: var(--art-scrim); padding: var(--s-1); }
@media (max-width: 600px) { .photoswipe-stage { inset: 60px 38px 76px; } }
</style>
