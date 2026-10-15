<template>
  <div
    ref="containerEl"
    class="image-split-compare tw:[container-type:inline-size] tw:relative tw:w-full tw:h-full tw:overflow-hidden tw:select-none tw:touch-none tw:cursor-ew-resize tw:rounded-sm tw:bg-deep"
    :class="{ 'is-dragging': isDragging }"
    role="slider"
    tabindex="0"
    :aria-label="comparisonLabel"
    aria-orientation="horizontal"
    :aria-valuenow="Math.round(splitPos)"
    :aria-valuetext="splitValueText"
    aria-valuemin="0"
    aria-valuemax="100"
    @keydown="onKeydown"
    @pointerdown="startDrag"
    @pointermove="onDrag"
    @pointerup="stopDrag"
    @pointercancel="stopDrag"
    @lostpointercapture="stopDrag"
  >
    <!-- Before Image (Base layer) -->
    <div class="split-layer layer-before tw:absolute tw:inset-0 tw:w-full tw:h-full tw:pointer-events-none">
      <img :crossorigin="runtimeResourceCors()" :src="resolveRuntimeUrl(beforeSrc)" :alt="beforeLabel || '原图'" class="split-img tw:w-full tw:h-full tw:object-contain tw:block" draggable="false" />
      <span class="split-badge badge-before tw:absolute tw:top-[10px] tw:text-label-xs tw:[padding:3px_8px] tw:rounded-xs tw:[z-index:var(--z-canvas)] tw:font-medium tw:left-[10px] tw:[background:color-mix(in_srgb,_black_70%,_transparent)] tw:[color:color-mix(in_srgb,_white_85%,_transparent)] tw:[border:1px_solid_color-mix(in_srgb,_white_15%,_transparent)]">{{ beforeLabel || '换装前' }}</span>
    </div>

    <!-- After Image (Clipped overlay) -->
    <div
      ref="clippedLayer"
      class="split-layer layer-after tw:absolute tw:inset-0 tw:w-full tw:h-full tw:pointer-events-none"
    >
      <div ref="clippedContent" class="split-after-content tw:absolute tw:inset-0">
      <img :crossorigin="runtimeResourceCors()" :src="resolveRuntimeUrl(afterSrc)" :alt="afterLabel || '换装后'" class="split-img tw:w-full tw:h-full tw:object-contain tw:block" draggable="false" />
      <span class="split-badge badge-after tw:absolute tw:top-[10px] tw:text-label-xs tw:[padding:3px_8px] tw:rounded-xs tw:[z-index:var(--z-canvas)] tw:font-medium tw:right-[10px] tw:[background:var(--compare-badge-fill)] tw:[color:var(--archive-blue)] tw:[border:1px_solid_var(--compare-badge-edge)]">{{ afterLabel || '换装后' }}</span>
      </div>
    </div>

    <!-- Split Divider Handle -->
    <div
      ref="divider"
      class="split-divider tw:absolute tw:top-0 tw:bottom-0 tw:left-0 tw:w-[2px] tw:[z-index:5] tw:pointer-events-none"
      aria-hidden="true"
    >
      <div class="divider-line tw:absolute tw:inset-0 tw:[background:var(--archive-blue)] tw:[box-shadow:0_0_8px_var(--compare-divider-glow)]"></div>
      <div class="divider-handle tw:absolute tw:top-1/2 tw:left-1/2 tw:w-[28px] tw:h-[28px] tw:rounded-full tw:bg-deep tw:[border:2px_solid_var(--archive-blue)] tw:[box-shadow:0_2px_8px_color-mix(in_srgb,_black_70%,_transparent)] tw:flex tw:items-center tw:justify-center tw:[color:var(--archive-blue)]">
        <ArchiveIcon name="compare" class="divider-icon tw:text-label-sm" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { resolveRuntimeUrl, runtimeResourceCors } from '@/platform/runtimeUrl'

import { computed } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { useImageComparison } from '@/composables/useImageComparison'

const props = defineProps<{
  beforeSrc: string
  afterSrc: string
  beforeLabel?: string
  afterLabel?: string
  initialPos?: number
}>()

const beforeName = computed(() => props.beforeLabel || '原图')
const afterName = computed(() => props.afterLabel || '换装后')
const { position: splitPos, container: containerEl, clippedLayer, clippedContent, divider, isDragging, startDrag, onDrag, stopDrag, onKeydown } = useImageComparison(
  props.initialPos ?? 50, 'right', value => `对比位置 ${value}%：${beforeName.value}与${afterName.value}`,
)
const comparisonLabel = computed(() => `左右对比滑动条：${beforeName.value}与${afterName.value}`)
const splitValueText = computed(() => `对比位置 ${Math.round(splitPos.value)}%：${beforeName.value}与${afterName.value}`)
</script>

<style scoped>
.image-split-compare {
  --compare-badge-fill: rgba(56, 189, 248, 0.2);
  --compare-badge-edge: rgba(56, 189, 248, 0.4);
  --compare-divider-glow: rgba(56, 189, 248, 0.6);
}
.image-split-compare:focus-visible {
  outline: none;
  box-shadow: var(--focus-shadow);
}

.layer-after {
  overflow: hidden;
  transform: translateX(50%);
}
.split-after-content { transform: translateX(-50%); }

.split-badge {
  backdrop-filter: blur(6px);
}

.split-divider {
  transform: translateX(calc(50cqw - 50%));
}

.divider-handle {
  transform: translate(-50%, -50%);
}
.image-split-compare:hover .divider-handle {
  outline: none;
  box-shadow: var(--focus-shadow);
}

.is-dragging .divider-handle {
  transform: translate(-50%, -50%) scale(1.15);
  background: var(--archive-blue);
  color: var(--bg-deep);
}
@media (forced-colors: active) {
  .image-split-compare:focus-visible, .image-split-compare:hover .divider-handle { outline: 2px solid Highlight; outline-offset: 2px; }
}
</style>
