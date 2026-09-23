<template>
  <div
    ref="containerEl"
    class="zoomable-image-viewer"
    :class="{ 'is-zoomed': scale > 1.01, 'is-panning': isPanning }"
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

    <!-- 缩放控制浮标 (放大时浮现) -->
    <div v-if="scale > 1.01" class="zoom-controls">
      <span class="zoom-level">{{ Math.round(scale * 100) }}%</span>
      <StudioTooltip content="还原 100%">
        <button type="button" class="btn-reset-zoom" @click.stop="resetZoom">
          还原
        </button>
      </StudioTooltip>
    </div>
    <div v-else class="zoom-hint">
      双击或滚轮放大查看细节
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
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

// 自定义属性载体：变换规则留在 scoped CSS，内联只承载数据（style-debt 门禁约定）
const zoomLayerStyle = computed(() => ({
  '--zoom-transform': `translate(${translateX.value}px, ${translateY.value}px) scale(${scale.value})`,
}))
let startX = 0
let startY = 0
let initialTranslateX = 0
let initialTranslateY = 0

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

function toggleZoom(event: MouseEvent) {
  if (scale.value > 1.05) {
    resetZoom()
  } else {
    scale.value = 2.2
    // 聚焦到点击位置
    if (containerEl.value) {
      const rect = containerEl.value.getBoundingClientRect()
      const offsetX = event.clientX - (rect.left + rect.width / 2)
      const offsetY = event.clientY - (rect.top + rect.height / 2)
      translateX.value = -offsetX * 1.2
      translateY.value = -offsetY * 1.2
    }
  }
}

function handleWheel(event: WheelEvent) {
  const delta = event.deltaY < 0 ? 0.25 : -0.25
  const newScale = Math.max(minScale, Math.min(maxScale, scale.value + delta))
  if (newScale <= 1.01) {
    resetZoom()
    return
  }
  scale.value = Number(newScale.toFixed(2))
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
  gap: 8px;
  padding: 4px 12px;
  border-radius: var(--r-pill);
  background: color-mix(in srgb, black 75%, transparent);
  border: 1px solid color-mix(in srgb, white 15%, transparent);
  backdrop-filter: blur(8px);
  z-index: var(--z-raised);
  font-size: var(--fs-label-sm);
  color: #fff;
}

.zoom-level {
  font-family: var(--font-mono, monospace);
  font-weight: 600;
  color: var(--archive-blue);
}

.btn-reset-zoom {
  border: 0;
  background: color-mix(in srgb, white 15%, transparent);
  color: #fff;
  padding: 2px 8px;
  border-radius: var(--r-xs);
  cursor: pointer;
  font-size: var(--fs-mono-sm);
}

.btn-reset-zoom:hover {
  background: var(--archive-blue);
  color: #000;
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
