<template>
  <div
    ref="containerRef"
    class="image-compare-slider"
    role="slider"
    :aria-valuenow="Math.round(splitRatio * 100)"
    aria-valuemin="0"
    aria-valuemax="100"
    aria-label="图像对比滑块"
    tabindex="0"
    :style="sliderStyle"
    @keydown="onKeydown"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
  >
    <!-- 底层 (After: 高清/修复后) -->
    <img :crossorigin="runtimeResourceCors()" class="compare-img after-img" :src="resolveRuntimeUrl(afterSrc)" :alt="afterLabel" decoding="async" />
    <span class="compare-badge badge-after">{{ afterLabel }}</span>

    <!-- 顶层 (Before: 原图，根据 splitRatio 裁剪) -->
    <div class="compare-overlay">
      <img :crossorigin="runtimeResourceCors()" class="compare-img before-img" :src="resolveRuntimeUrl(beforeSrc)" :alt="beforeLabel" decoding="async" />
      <span class="compare-badge badge-before">{{ beforeLabel }}</span>
    </div>

    <!-- 分割线与拖拽手柄 -->
    <div class="compare-divider">
      <div class="compare-handle" aria-hidden="true">
        <span class="handle-arrow">‹</span>
        <span class="handle-arrow">›</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { resolveRuntimeUrl, runtimeResourceCors } from '@/platform/runtimeUrl'

import { ref, computed } from 'vue'

const props = withDefaults(defineProps<{
  beforeSrc: string
  afterSrc: string
  beforeLabel?: string
  afterLabel?: string
  initialRatio?: number
}>(), {
  beforeLabel: '原图',
  afterLabel: '高清放大',
  initialRatio: 0.5,
})

const splitRatio = ref(props.initialRatio)
const sliderStyle = computed(() => ({
  '--split-pos': `${Math.round(splitRatio.value * 1000) / 10}%`,
  '--split-x': `${Math.round(splitRatio.value * 1000) / 10}cqw`,
  '--clip-pos': `${Math.round((1 - splitRatio.value) * 1000) / 10}%`,
}))
const containerRef = ref<HTMLElement | null>(null)
let isDragging = false

function updateRatioFromPointer(clientX: number) {
  if (!containerRef.value) return
  const rect = containerRef.value.getBoundingClientRect()
  if (rect.width <= 0) return
  const raw = (clientX - rect.left) / rect.width
  splitRatio.value = Math.max(0.02, Math.min(0.98, raw))
}

function onPointerDown(e: PointerEvent) {
  isDragging = true
  const el = containerRef.value
  if (el) el.setPointerCapture(e.pointerId)
  updateRatioFromPointer(e.clientX)
}

function onPointerMove(e: PointerEvent) {
  if (!isDragging) return
  updateRatioFromPointer(e.clientX)
}

function onPointerUp(e: PointerEvent) {
  if (!isDragging) return
  isDragging = false
  const el = containerRef.value
  if (el && el.hasPointerCapture(e.pointerId)) {
    el.releasePointerCapture(e.pointerId)
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'ArrowLeft') {
    e.preventDefault()
    splitRatio.value = Math.max(0, Math.round((splitRatio.value - 0.05) * 100) / 100)
  } else if (e.key === 'ArrowRight') {
    e.preventDefault()
    splitRatio.value = Math.min(1, Math.round((splitRatio.value + 0.05) * 100) / 100)
  }
}
</script>

<style scoped>
.image-compare-slider {
  container-type: inline-size;
  position: relative;
  display: block;
  width: 100%;
  height: 100%;
  overflow: hidden;
  user-select: none;
  cursor: ew-resize;
  touch-action: none;
  border-radius: var(--r-md);
  outline: 0;
}

.image-compare-slider:focus-visible .compare-handle {
  box-shadow: 0 0 0 2px var(--accent), 0 0 12px var(--glass-shadow);
}

.compare-img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  pointer-events: none;
}

.compare-overlay {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  clip-path: inset(0 var(--clip-pos, 50%) 0 0);
  pointer-events: none;
}

.compare-badge {
  position: absolute;
  bottom: var(--s-3);
  padding: 2px var(--s-2);
  border-radius: var(--r-pill);
  background: color-mix(in srgb, var(--bg-deep) 85%, transparent);
  color: var(--text-secondary);
  font: 700 var(--fs-label-xs) var(--font-mono);
  letter-spacing: .05em;
  backdrop-filter: blur(8px);
  pointer-events: none;
  z-index: var(--z-raised);
}

.badge-before { left: var(--s-3); }
.badge-after { right: var(--s-3); }

.compare-divider {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 2px;
  background: color-mix(in srgb, var(--accent) 80%, var(--text-primary));
  box-shadow: var(--shadow-md);
  transform: translateX(calc(var(--split-x, 50cqw) - 50%));
  pointer-events: none;
  z-index: var(--z-overlay);
}

.compare-handle {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 2px;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--bg-elevated);
  border: 1px solid var(--accent);
  color: var(--accent);
  box-shadow: var(--shadow-md);
  font-size: var(--fs-body-sm);
  font-weight: 700;
}

.handle-arrow { line-height: var(--lh-flush); }
</style>
