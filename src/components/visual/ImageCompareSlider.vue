<template>
  <div
    ref="containerRef"
    class="image-compare-slider tw:[container-type:inline-size] tw:relative tw:block tw:w-full tw:h-full tw:overflow-hidden tw:select-none tw:cursor-ew-resize tw:touch-none tw:rounded-md tw:[outline:0]"
    :class="{ 'is-dragging': isDragging }"
    role="slider"
    :aria-valuenow="Math.round(splitPos)"
    :aria-valuetext="`对比位置 ${Math.round(splitPos)}%：${beforeLabel}与${afterLabel}`"
    aria-valuemin="0"
    aria-valuemax="100"
    aria-label="图像对比滑块"
    aria-orientation="horizontal"
    tabindex="0"
    :style="sliderStyle"
    @keydown="onKeydown"
    @pointerdown="startDrag"
    @pointermove="onDrag"
    @pointerup="stopDrag"
    @pointercancel="stopDrag"
    @lostpointercapture="stopDrag"
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
        <ArchiveIcon name="compare" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { resolveRuntimeUrl, runtimeResourceCors } from '@/platform/runtimeUrl'
import { computed } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { useImageComparison } from '@/composables/useImageComparison'

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

const { position: splitPos, container: containerRef, isDragging, startDrag, onDrag, stopDrag, onKeydown } = useImageComparison(props.initialRatio * 100)
const sliderStyle = computed(() => ({
  '--split-pos': `${splitPos.value}%`,
  '--split-x': `${splitPos.value}cqw`,
  '--clip-pos': `${100 - splitPos.value}%`,
}))
</script>

<style scoped>
.image-compare-slider:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.image-compare-slider:hover .compare-handle {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.image-compare-slider.is-dragging .compare-handle {
  transform: translate(-50%, -50%) scale(1.15);
  background: var(--accent);
  color: var(--text-inverse);
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
@media (forced-colors: active) {
  .image-compare-slider:focus-visible, .image-compare-slider:hover .compare-handle { outline-color: Highlight; }
}
</style>
