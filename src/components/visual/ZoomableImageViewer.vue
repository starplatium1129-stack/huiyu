<template>
  <div
    ref="containerEl"
    class="zoomable-image-viewer"
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
    @dblclick="toggleZoom"
  >
    <div
      class="zoom-transform-layer"
      :style="zoomLayerStyle"
    >
      <!-- 骨架屏占位 -->
      <div v-if="!imageReady && !imageFailed" class="skeleton-placeholder">
        <div class="skeleton-shimmer"></div>
      </div>

      <!-- 真实图片 -->
      <img
        v-show="!imageFailed"
        ref="imageEl"
        :src="src"
        :alt="alt"
        class="zoomable-img"
        :class="{ 'is-ready': imageReady }"
        draggable="false"
        @load="onImageLoad"
        @error="onImageError"
      />

      <!-- 失败占位 -->
      <div v-if="imageFailed" class="image-fallback">
        <slot name="fallback">
          <span>图片暂时无法读取</span>
        </slot>
      </div>
    </div>

    <!-- 缩放控制始终可见，键盘和触摸用户不必先猜测手势。 -->
    <div class="zoom-controls" role="group" aria-label="图片缩放控制" @pointerdown.stop @dblclick.stop>
      <span class="zoom-level" aria-live="polite">{{ Math.round(scale * 100) }}%</span>
      <StudioTooltip content="放大">
        <button type="button" class="zoom-control" aria-label="放大图片" @pointerdown.stop @click.stop="zoomIn">
          <ArchiveIcon name="expand" />
        </button>
      </StudioTooltip>
      <StudioTooltip content="缩小">
        <button type="button" class="zoom-control" aria-label="缩小图片" @pointerdown.stop @click.stop="zoomOut">
          <ArchiveIcon name="compress" />
        </button>
      </StudioTooltip>
      <StudioTooltip content="还原 100%">
        <button type="button" class="zoom-control btn-reset-zoom" aria-label="还原图片缩放" @pointerdown.stop @click.stop="resetZoom">
          <ArchiveIcon name="refresh" />
        </button>
      </StudioTooltip>
    </div>
    <div v-if="scale <= 1.01" class="zoom-hint">
      双击或滚轮放大查看细节
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'

const props = defineProps<{
  src: string
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

const containerEl = ref<HTMLElement | null>(null)
const imageEl = ref<HTMLImageElement | null>(null)
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
const ZOOM_STEP = 0.25
const KEYBOARD_PAN_STEP = 32

function onImageLoad() {
  imageReady.value = true
  imageFailed.value = false
  emit('load')
}

function onImageError() {
  imageReady.value = false
  imageFailed.value = true
  emit('error')
}

watch(() => props.src, () => {
  imageReady.value = false
  imageFailed.value = false
  resetZoom()
})

function resetZoom() {
  scale.value = 1
  translateX.value = 0
  translateY.value = 0
  isPanning.value = false
}

function setScale(nextScale: number) {
  const boundedScale = Math.max(minScale, Math.min(maxScale, nextScale))
  if (boundedScale <= 1.01) {
    resetZoom()
    return
  }
  scale.value = Number(boundedScale.toFixed(2))
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
  scale.value = Number(targetScale.toFixed(2))
  // 聚焦到点击位置
  if (containerEl.value) {
    const rect = containerEl.value.getBoundingClientRect()
    const offsetX = event.clientX - (rect.left + rect.width / 2)
    const offsetY = event.clientY - (rect.top + rect.height / 2)
    translateX.value = -offsetX * 1.2
    translateY.value = -offsetY * 1.2
  }
}

function handleWheel(event: WheelEvent) {
  setScale(scale.value + (event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP))
}

function onKeydown(event: KeyboardEvent) {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return
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
  if (scale.value <= 1.01) return
  isPanning.value = true
  startX = event.clientX
  startY = event.clientY
  initialTranslateX = translateX.value
  initialTranslateY = translateY.value
  event.currentTarget instanceof HTMLElement && event.currentTarget.setPointerCapture(event.pointerId)
}

function onPan(event: PointerEvent) {
  if (!isPanning.value) return
  const dx = event.clientX - startX
  const dy = event.clientY - startY
  translateX.value = initialTranslateX + dx
  translateY.value = initialTranslateY + dy
}

function stopPan(event: PointerEvent) {
  if (isPanning.value) {
    isPanning.value = false
    try {
      event.currentTarget instanceof HTMLElement && event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {}
  }
}
</script>

<style scoped>
.zoomable-image-viewer {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 280px;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  user-select: none;
  cursor: zoom-in;
  touch-action: none;
}

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

.zoomable-image-viewer.is-panning .zoom-transform-layer {
  transition: none;
}

.zoom-transform-layer {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  max-width: 100%;
  max-height: 100%;
  transform: var(--zoom-transform, none);
  transform-origin: center center;
  transition: transform var(--motion-control) var(--ease-out);
}

.skeleton-placeholder {
  position: absolute;
  inset: 0;
  min-width: 240px;
  min-height: 320px;
  border-radius: var(--r-lg, 12px);
  background: color-mix(in srgb, white 4%, transparent);
  overflow: hidden;
}

.skeleton-shimmer {
  position: absolute;
  inset: 0;
  transform: translateX(-100%);
  background: linear-gradient(
    90deg,
    transparent 0%,
    color-mix(in srgb, white 8%, transparent) 50%,
    transparent 100%
  );
  animation: shimmer 1.6s infinite;
}

@keyframes shimmer {
  100% {
    transform: translateX(100%);
  }
}

.zoomable-img {
  display: block;
  max-width: 100%;
  max-height: min(88vh, 860px);
  width: auto;
  height: auto;
  object-fit: contain;
  border-radius: var(--r-lg, 12px);
  opacity: 0;
  filter: blur(8px);
  transition: opacity var(--motion-route) ease, filter var(--motion-route-cut) ease;
}

.zoomable-img.is-ready {
  opacity: 1;
  filter: blur(0);
}

.image-fallback {
  color: var(--on-art-secondary, color-mix(in srgb, white 60%, transparent));
  font-size: var(--fs-body-sm, 0.85rem);
}

.zoom-controls {
  position: absolute;
  bottom: 12px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px;
  border-radius: var(--r-pill);
  background: color-mix(in srgb, var(--bg-deep) 84%, transparent);
  border: 1px solid var(--border-soft);
  backdrop-filter: blur(8px);
  z-index: var(--z-raised);
  font-size: var(--fs-label-sm);
  color: var(--text-primary);
}

.zoom-level {
  margin: 0 4px;
  font-family: var(--font-mono, monospace);
  font-weight: 600;
  color: var(--archive-blue);
}

.zoom-control {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 50%;
  background: color-mix(in srgb, var(--bg-elevated) 78%, transparent);
  color: var(--text-primary);
  cursor: pointer;
}

.zoom-control:hover {
  border-color: color-mix(in srgb, var(--accent) 48%, var(--border-soft));
  background: var(--accent-soft);
  color: var(--accent);
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

.zoom-hint {
  position: absolute;
  bottom: 8px;
  right: 12px;
  font-size: var(--fs-mono-sm);
  color: color-mix(in srgb, white 40%, transparent);
  pointer-events: none;
}

@media (prefers-reduced-motion: reduce) {
  .skeleton-shimmer { animation:none; }
  .zoom-transform-layer { transition:none; }
  .zoomable-img { filter:none; transition:opacity var(--motion-press) ease-out; }
}
</style>
