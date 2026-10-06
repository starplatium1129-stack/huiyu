<template>
  <div
    class="zoomable-image-viewer tw:relative tw:w-full tw:h-full tw:min-h-[280px] tw:flex tw:items-center tw:justify-center tw:overflow-hidden tw:select-none tw:cursor-zoom-in tw:touch-none"
    :class="{ 'is-zoomed': scale > 1.01, 'is-panning': isPanning }"
    role="group"
    tabindex="0"
    :aria-label="viewerLabel"
    @keydown="onKeydown"
    @wheel.prevent="handleWheel"
    @pointerdown="startPan"
    @pointermove="onPan"
    @pointerup="stopPan"
    @pointercancel="stopPan"
    @lostpointercapture="stopPan"
    @dblclick="toggleZoom"
  >
    <div ref="viewportEl" class="zoom-viewport tw:relative tw:w-full tw:h-full tw:min-w-0 tw:min-h-0 tw:flex tw:items-center tw:justify-center tw:overflow-hidden">
    <div
      class="zoom-transform-layer tw:relative tw:flex tw:items-center tw:justify-center tw:max-w-full tw:max-h-full"
      :style="zoomLayerStyle"
    >
      <!-- 骨架屏占位 -->
      <div v-if="!imageReady && !imageFailed && !previewSrc" class="skeleton-placeholder tw:absolute tw:inset-0 tw:min-w-[240px] tw:min-h-[320px] tw:[border-radius:var(--r-lg,_12px)] tw:[background:var(--bg-elevated)]" aria-hidden="true"></div>

      <!-- 真实图片 -->
      <img :crossorigin="runtimeResourceCors()"
        v-show="!imageFailed"
        ref="imageEl"
        :src="resolveRuntimeUrl(displayedSrc)"
        :alt="alt"
        class="zoomable-img tw:block tw:max-w-full tw:[max-height:min(88vh,_860px)] tw:w-auto tw:h-auto tw:object-contain tw:[border-radius:var(--r-lg,_12px)]"
        :class="{ 'is-ready': imageReady || !!previewSrc }"
        draggable="false"
        @load="onImageLoad"
        @error="onImageError"
      />

      <!-- Decode the original offscreen while the already-loaded thumbnail stays visible. -->
      <img v-if="displayedSrc !== src && !fullImageFailed" :key="src" ref="fullImageEl"
        :crossorigin="runtimeResourceCors()" :src="resolveRuntimeUrl(src)" class="zoomable-preload tw:hidden"
        alt="" aria-hidden="true" @load="upgradeImage" @error="onFullImageError" />
      <span v-if="fullImageFailed && !imageFailed" class="preview-quality-note tw:absolute tw:top-s-3 tw:left-s-3 tw:right-s-3 tw:p-s-2 tw:rounded-sm tw:[background:var(--art-scrim)] tw:[color:var(--on-art-primary)] tw:text-label-sm tw:text-center" role="status">高清图暂时无法读取，当前显示缩略图</span>

      <!-- 失败占位 -->
      <div v-if="imageFailed" class="image-fallback tw:[color:var(--on-art-secondary,_color-mix(in_srgb,_white_60%,_transparent))] tw:[font-size:var(--fs-body-sm,_0.85rem)]">
        <slot name="fallback">
          <span>图片暂时无法读取</span>
        </slot>
      </div>
    </div>
    </div>

    <!-- 缩放控制始终可见，键盘和触摸用户不必先猜测手势。 -->
    <div class="zoom-toolbar" @pointerdown.stop @dblclick.stop @wheel.stop>
    <div data-fluid-glass class="zoom-controls tw:absolute tw:bottom-[12px] tw:left-1/2 tw:flex tw:items-center tw:gap-[6px] tw:p-[4px] tw:rounded-pill tw:[background:color-mix(in_srgb,_var(--bg-deep)_84%,_transparent)] tw:border tw:border-solid tw:border-soft tw:[z-index:var(--z-raised)] tw:text-label-sm tw:text-primary" role="group" aria-label="图片缩放控制" @pointerdown.stop @dblclick.stop>
      <span class="zoom-level tw:[margin:0_4px] tw:[font-family:var(--font-mono,_monospace)] tw:font-semibold tw:[color:var(--archive-blue)]" aria-live="polite">{{ Math.round(scale * 100) }}%</span>
      <button type="button" class="zoom-control tw:grid tw:place-items-center tw:w-[36px] tw:h-[36px] tw:p-0 tw:border tw:border-solid tw:border-transparent tw:rounded-full tw:[background:color-mix(in_srgb,_var(--bg-elevated)_78%,_transparent)] tw:text-primary tw:cursor-pointer" aria-label="放大图片" @pointerdown.stop @click.stop="zoomIn">
        <ArchiveIcon name="expand" />
      </button>
      <button type="button" class="zoom-control tw:grid tw:place-items-center tw:w-[36px] tw:h-[36px] tw:p-0 tw:border tw:border-solid tw:border-transparent tw:rounded-full tw:[background:color-mix(in_srgb,_var(--bg-elevated)_78%,_transparent)] tw:text-primary tw:cursor-pointer" aria-label="缩小图片" @pointerdown.stop @click.stop="zoomOut">
        <ArchiveIcon name="compress" />
      </button>
      <button type="button" class="zoom-control btn-reset-zoom tw:grid tw:place-items-center tw:w-[36px] tw:h-[36px] tw:p-0 tw:border tw:border-solid tw:border-transparent tw:rounded-full tw:[background:color-mix(in_srgb,_var(--bg-elevated)_78%,_transparent)] tw:text-primary tw:cursor-pointer" aria-label="还原图片缩放" @pointerdown.stop @click.stop="resetZoom">
        <ArchiveIcon name="refresh" />
      </button>
    </div>
    <div v-if="scale <= 1.01" class="zoom-hint tw:absolute tw:bottom-[8px] tw:right-[12px] tw:text-mono-sm tw:text-secondary tw:pointer-events-none">
      双击或滚轮放大查看细节
    </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { resolveRuntimeUrl, runtimeResourceCors } from '@/platform/runtimeUrl'

import { computed, onBeforeUnmount, ref, watch } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'

const props = defineProps<{
  src: string
  /** An already-visible, unrestricted thumbnail; it keeps the first frame continuous. */
  previewSrc?: string
  alt?: string
  minScale?: number
  maxScale?: number
}>()

const emit = defineEmits<{
  (e: 'load'): void
  (e: 'error'): void
}>()

const minScale = props.minScale ?? 1
const maxScale = props.maxScale ?? 4

const viewportEl = ref<HTMLElement | null>(null)
const imageEl = ref<HTMLImageElement | null>(null)
const fullImageEl = ref<HTMLImageElement | null>(null)
const displayedSrc = ref(props.previewSrc || props.src)
const fullImageFailed = ref(false)
let sourceRevision = 0
onBeforeUnmount(() => { sourceRevision++; releasePan() })
const imageReady = ref(false)
const imageFailed = ref(false)

const scale = ref(1)
const translateX = ref(0)
const translateY = ref(0)
const isPanning = ref(false)
const viewerLabel = computed(() => props.alt ? `${props.alt}查看器` : '图片查看器')

// 自定义属性载体：变换规则留在 scoped CSS，内联只承载数据（style-debt 门禁约定）
const zoomLayerStyle = computed(() => ({
  '--zoom-transform': `translate(${translateX.value}px, ${translateY.value}px) scale(${scale.value})`,
}))
let startX = 0
let startY = 0
let initialTranslateX = 0
let initialTranslateY = 0
let panTarget: HTMLElement | null = null
let panPointerId: number | null = null
const ZOOM_STEP = 0.25
const KEYBOARD_PAN_STEP = 32

function onImageLoad() {
  imageReady.value = true
  imageFailed.value = false
  emit('load')
}

function onImageError() {
  if (displayedSrc.value !== props.src) { displayedSrc.value = props.src; return }
  imageReady.value = false
  imageFailed.value = true
  emit('error')
}

async function upgradeImage(event: Event) {
  const image = event.target as HTMLImageElement, revision = sourceRevision
  try { if (typeof image.decode === 'function') await image.decode() }
  catch { if (revision === sourceRevision && fullImageEl.value === image) onFullImageError(); return }
  if (revision === sourceRevision && fullImageEl.value === image) displayedSrc.value = props.src
}
function onFullImageError() { fullImageFailed.value = true; emit('error') }

watch(() => [props.src, props.previewSrc], ([src, preview], [previousSrc, previousPreview]) => {
  if (src !== previousSrc) sourceRevision++
  fullImageFailed.value = false
  // A newly hydrated original for the same preview is a quality upgrade, not
  // navigation. Keep its painted frame and the user's zoom while it decodes.
  if (!imageFailed.value && ((preview && preview === previousPreview)
    || (src === previousSrc && imageReady.value))) return
  displayedSrc.value = props.previewSrc || props.src
  imageReady.value = false
  imageFailed.value = false
  resetZoom()
})

function resetZoom() {
  releasePan()
  scale.value = 1
  translateX.value = 0
  translateY.value = 0
  isPanning.value = false
}

function setScale(nextScale: number, point?: { clientX: number; clientY: number }) {
  const boundedScale = Math.max(minScale, Math.min(maxScale, nextScale))
  if (boundedScale <= 1.01) {
    resetZoom()
    return
  }
  const next = Number(boundedScale.toFixed(2))
  const rect = viewportEl.value?.getBoundingClientRect()
  const anchorX = point && rect ? point.clientX - rect.left - rect.width / 2 : 0
  const anchorY = point && rect ? point.clientY - rect.top - rect.height / 2 : 0
  const ratio = next / scale.value
  translateX.value = anchorX - (anchorX - translateX.value) * ratio
  translateY.value = anchorY - (anchorY - translateY.value) * ratio
  scale.value = next
}

function zoomIn() {
  setScale(scale.value + ZOOM_STEP)
}

function zoomOut() {
  setScale(scale.value - ZOOM_STEP)
}

function toggleZoom(event: MouseEvent) {
  if (scale.value > 1.05) {
    resetZoom()
    return
  }
  const targetScale = Math.max(minScale, Math.min(maxScale, 2.2))
  if (targetScale <= 1.01) {
    resetZoom()
    return
  }
  setScale(targetScale, event)
}

function handleWheel(event: WheelEvent) {
  if (event.deltaY) setScale(scale.value + (event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP), event)
}

function onKeydown(event: KeyboardEvent) {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey || event.target !== event.currentTarget) return
  if (event.key === '+' || event.key === '=') { event.preventDefault(); zoomIn(); return }
  if (event.key === '-') { event.preventDefault(); zoomOut(); return }
  if (event.key === 'Home') {
    event.preventDefault()
    resetZoom()
    return
  }
  if (scale.value <= 1.01) return

  let dx = 0
  let dy = 0
  if (event.key === 'ArrowLeft') dx = -KEYBOARD_PAN_STEP
  else if (event.key === 'ArrowRight') dx = KEYBOARD_PAN_STEP
  else if (event.key === 'ArrowUp') dy = -KEYBOARD_PAN_STEP
  else if (event.key === 'ArrowDown') dy = KEYBOARD_PAN_STEP
  else return

  event.preventDefault()
  isPanning.value = false
  translateX.value += dx
  translateY.value += dy
}

function startPan(event: PointerEvent) {
  if (scale.value <= 1.01 || isPanning.value || event.button !== 0) return
  isPanning.value = true
  startX = event.clientX
  startY = event.clientY
  initialTranslateX = translateX.value
  initialTranslateY = translateY.value
  panTarget = event.currentTarget instanceof HTMLElement ? event.currentTarget : null
  panPointerId = event.pointerId
  panTarget?.setPointerCapture(event.pointerId)
}

function onPan(event: PointerEvent) {
  if (!isPanning.value || event.pointerId !== panPointerId) return
  const dx = event.clientX - startX
  const dy = event.clientY - startY
  translateX.value = initialTranslateX + dx
  translateY.value = initialTranslateY + dy
}

function stopPan(event: PointerEvent) {
  if (event.pointerId === panPointerId) releasePan()
}

function releasePan() {
  const target = panTarget, pointerId = panPointerId
  panTarget = null
  panPointerId = null
  isPanning.value = false
  if (target && pointerId !== null) {
    try { target.releasePointerCapture(pointerId) } catch {}
  }
}
</script>

<style scoped>
.zoomable-image-viewer:focus-visible {
  outline: 2px solid var(--archive-blue);
  outline-offset: -2px;
}

.zoomable-image-viewer.is-zoomed {
  cursor: grab;
}

.zoomable-image-viewer.is-panning {
  cursor: grabbing;
}

.zoom-transform-layer {
  transform: var(--zoom-transform, none);
  transform-origin: center center;
  /* Wheel, keyboard and drag follow the input directly, without queued zoom. */
}

.zoomable-img {
  opacity: 0;
  transition: opacity var(--motion-hover) var(--ease-out);
}

.zoomable-img.is-ready {
  opacity: 1;
}

.zoom-controls {
  transform: translateX(-50%);
  backdrop-filter: blur(8px);
}

/* Hosts can dock the existing toolbar outside the clipped art viewport. */
.zoom-toolbar { display: contents; }

@media (hover: hover) and (pointer: fine) {
  .zoom-control:hover {
    border-color: color-mix(in srgb, var(--accent) 48%, var(--border-soft));
    background: var(--accent-soft);
    color: var(--accent);
  }
}

.zoom-control:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.zoom-control :deep(.archive-icon) {
  font-size: 16px;
}

@media (pointer: coarse) {
  .zoom-control { width: 44px; height: 44px; }
  .zoom-hint { display: none; }
}

@media (max-width: 600px) {
  .zoom-hint { display: none; }
}

@media (prefers-reduced-motion: reduce) {
  .zoomable-img { transition:opacity var(--motion-press) var(--ease-out); }
}
:root:is([data-motion='reduce'], [data-motion='reduced']) .zoomable-img { transition:opacity var(--motion-press) var(--ease-out); }
</style>
