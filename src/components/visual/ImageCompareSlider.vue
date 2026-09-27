<template>
  <div
    ref="containerRef"
    class="image-compare-slider tw:[container-type:inline-size] tw:relative tw:block tw:w-full tw:h-full tw:overflow-hidden tw:select-none tw:cursor-ew-resize tw:touch-none tw:rounded-md tw:[outline:0]"
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
    <img :crossorigin="runtimeResourceCors()" class="compare-img after-img tw:absolute tw:inset-0 tw:w-full tw:h-full tw:object-contain tw:pointer-events-none" :src="resolveRuntimeUrl(afterSrc)" :alt="afterLabel" decoding="async" />
    <span class="compare-badge badge-after tw:absolute tw:bottom-s-3 tw:[padding:2px_var(--s-2)] tw:rounded-pill tw:[background:color-mix(in_srgb,_var(--bg-deep)_85%,_transparent)] tw:text-secondary tw:[font:700_var(--fs-label-xs)_var(--font-mono)] tw:[letter-spacing:.05em] tw:pointer-events-none tw:[z-index:var(--z-raised)] tw:right-s-3">{{ afterLabel }}</span>

    <!-- 顶层 (Before: 原图，根据 splitRatio 裁剪) -->
    <div class="compare-overlay tw:absolute tw:inset-0 tw:w-full tw:h-full tw:pointer-events-none">
      <img :crossorigin="runtimeResourceCors()" class="compare-img before-img tw:absolute tw:inset-0 tw:w-full tw:h-full tw:object-contain tw:pointer-events-none" :src="resolveRuntimeUrl(beforeSrc)" :alt="beforeLabel" decoding="async" />
      <span class="compare-badge badge-before tw:absolute tw:bottom-s-3 tw:[padding:2px_var(--s-2)] tw:rounded-pill tw:[background:color-mix(in_srgb,_var(--bg-deep)_85%,_transparent)] tw:text-secondary tw:[font:700_var(--fs-label-xs)_var(--font-mono)] tw:[letter-spacing:.05em] tw:pointer-events-none tw:[z-index:var(--z-raised)] tw:left-s-3">{{ beforeLabel }}</span>
    </div>

    <!-- 分割线与拖拽手柄 -->
    <div class="compare-divider tw:absolute tw:top-0 tw:bottom-0 tw:left-0 tw:w-[2px] tw:[background:color-mix(in_srgb,_var(--accent)_80%,_var(--text-primary))] tw:shadow-(--shadow-md) tw:pointer-events-none tw:[z-index:var(--z-overlay)]">
      <div class="compare-handle tw:absolute tw:top-1/2 tw:left-1/2 tw:flex tw:items-center tw:justify-center tw:gap-[2px] tw:w-[28px] tw:h-[28px] tw:rounded-full tw:bg-elevated tw:[border:1px_solid_var(--accent)] tw:text-accent tw:shadow-(--shadow-md) tw:text-body-sm tw:font-bold" aria-hidden="true">
        <span class="handle-arrow tw:leading-flush">‹</span>
        <span class="handle-arrow tw:leading-flush">›</span>
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
.image-compare-slider:focus-visible .compare-handle {
  box-shadow: 0 0 0 2px var(--accent), 0 0 12px var(--glass-shadow);
}

.compare-overlay {
  clip-path: inset(0 var(--clip-pos, 50%) 0 0);
}

.compare-badge {
  backdrop-filter: blur(8px);
}

.compare-divider {
  transform: translateX(calc(var(--split-x, 50cqw) - 50%));
}

.compare-handle {
  transform: translate(-50%, -50%);
}
</style>
