<template>
  <div ref="host" class="photoswipe-stage tw:absolute" aria-label="手势观画">
    <div class="photoswipe-tools tw:absolute tw:flex tw:justify-center tw:items-center tw:flex-wrap tw:gap-s-2 tw:pointer-events-none tw:text-label-xs">
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
import { artworkRepository } from '@/storage/artworkRepository'
import { safeImageUrl } from '@/composables/gallery/galleryHelpers'
import { sameArtworkMedia } from '@/composables/gallery/artworkMediaIdentity'
import { prefersReducedMotion } from '@/utils/motionPreference'
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
const pending = new Map<number, AbortController>()
const decoding = new Set<HTMLImageElement>()
const motionMedia = window.matchMedia('(prefers-reduced-motion: reduce)')
function syncMotionPreference() {
  if (!viewer) return
  const reduced = prefersReducedMotion()
  viewer.options.zoomAnimationDuration = reduced ? 0 : 160
  if (reduced) viewer.animations.stopAll()
}
function toggleZoom(event: MouseEvent) {
  if (!viewer) return
  const duration = viewer.options.zoomAnimationDuration
  if (!event.detail) viewer.options.zoomAnimationDuration = 0
  viewer.toggleZoom()
  viewer.options.zoomAnimationDuration = duration
}

function releaseUrl(url: string) {
  if (ownedUrls.delete(url)) URL.revokeObjectURL(url)
}
function dispose() {
  revision++
  for (const request of pending.values()) request.abort()
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
  const items = props.items.map(item => ({ ...item }))
  const data = items.map(item => ({ type: 'image', src: '', width: Number(item.width) || 832, height: Number(item.height) || 1216, alt: item.sceneTitle || '作品' }))
  const reduced = prefersReducedMotion()
  let instance: PhotoSwipe
  try { instance = new PhotoSwipe({
    dataSource: data, index: props.index, appendToEl: element,
    getViewportSizeFn: () => ({ x: element.clientWidth, y: element.clientHeight }),
    // The Gallery dialog owns focus, keyboard navigation and body scroll.
    trapFocus: false, returnFocus: false, escKey: false, arrowKeys: false,
    close: false, zoom: false, counter: false, arrowPrev: false, arrowNext: false,
    showAnimationDuration: 0, hideAnimationDuration: 0, zoomAnimationDuration: reduced ? 0 : 160,
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
    for (const [index, request] of pending) {
      if (Math.abs(index - instance.currIndex) <= 2) continue
      pending.delete(index)
      request.abort()
      if (!urls.has(index)) {
        instance.contentLoader.getContentByIndex(index)?.destroy()
        instance.contentLoader.removeByIndex(index)
      }
    }
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
    const request = new AbortController()
    pending.set(index, request)
    void (async () => {
      let url = ''
      try {
        const item = items[index]
        const blob = item.image_id ? await artworkRepository.getImage(item.image_id, request.signal) : null
        if (revision !== token || request.signal.aborted || !sameArtworkMedia(item, props.items[index])) return
        url = blob ? URL.createObjectURL(blob) : safeImageUrl(item.image_url) || (item.image_data?.startsWith('data:image/') ? item.image_data : '')
        if (blob) ownedUrls.add(url)
        if (!url) throw new Error('missing image')
        urls.set(index, url)
        const image = new Image()
        decoding.add(image)
        // Repository cancellation does not release an Image already decoding.
        const cancelDecode = () => { image.removeAttribute('src'); decoding.delete(image) }
        request.signal.addEventListener('abort', cancelDecode, { once: true })
        image.src = url
        try { await image.decode() } finally {
          request.signal.removeEventListener('abort', cancelDecode)
          decoding.delete(image)
        }
        if (revision !== token || request.signal.aborted || !sameArtworkMedia(item, props.items[index]) || Math.abs(index - instance.currIndex) > 2) {
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
        if (revision === token && !request.signal.aborted) event.content.onError()
      } finally { if (pending.get(index) === request) pending.delete(index) }
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
// goTo's external-selection path is instant, including the dialog's arrow keys.
watch(() => props.index, index => { if (index >= 0 && viewer && viewer.currIndex !== index) viewer.goTo(index) })
watch(() => props.items.map(({ id, image_id, image_url, image_data }) => ({ id, image_id, image_url, image_data })), (items, previous) => {
  if (items.length !== previous.length || items.some((item, index) => !sameArtworkMedia(item, previous[index]))) start()
})
onMounted(() => {
  motionMedia.addEventListener('change', syncMotionPreference)
  window.addEventListener('atelier:motion-preference', syncMotionPreference)
  start()
})
onBeforeUnmount(() => {
  motionMedia.removeEventListener('change', syncMotionPreference)
  window.removeEventListener('atelier:motion-preference', syncMotionPreference)
  dispose()
})
</script>

<style scoped>
@reference "../../assets/css/tailwind.css";
.photoswipe-stage { inset: 60px 48px; }
.photoswipe-stage :deep(.pswp) { @apply tw:absolute; z-index: 0; }
.photoswipe-stage :deep(.pswp__error-msg) { color: var(--on-art-primary); }
.photoswipe-stage :deep(.pswp__top-bar) { @apply tw:hidden; }
.photoswipe-tools { z-index: 1; inset: auto 0 0; color: var(--on-art-secondary); }
.photoswipe-tools button { @apply tw:pointer-events-auto; background: var(--art-scrim); color: var(--on-art-primary); }
.photoswipe-tools span { background: var(--art-scrim); @apply tw:p-s-1; }
@media (max-width: 600px) { .photoswipe-stage { inset: 60px 38px 76px; } }
</style>
