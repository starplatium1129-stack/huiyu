<template>
  <div class="image-compare-slider" role="group" :aria-label="`${beforeLabel}与${afterLabel}对比`">
  <div
    ref="containerRef"
    class="compare-surface tw:[container-type:inline-size] tw:relative tw:block tw:w-full tw:h-full tw:overflow-hidden tw:select-none tw:cursor-ew-resize tw:touch-none tw:rounded-md tw:[outline:0]"
    :class="{ 'is-dragging': isDragging }"
    role="slider"
    :aria-valuenow="Math.round(splitPos)"
    :aria-valuetext="`对比位置 ${Math.round(splitPos)}%：${beforeLabel}与${afterLabel}`"
    aria-valuemin="0"
    aria-valuemax="100"
    aria-label="图像对比滑块，方向键调整，Home 和 End 查看单侧"
    aria-orientation="horizontal"
    tabindex="0"
    @keydown="onKeydown"
    @pointerdown="startDrag"
    @pointermove="onDrag"
    @pointerup="stopDrag"
    @pointercancel="stopDrag"
    @lostpointercapture="stopDrag"
  >
    <!-- 底层 (After: 高清/修复后) -->
    <img v-if="after.src.value && !after.failed.value" v-bind="after.image.value" class="compare-img after-img tw:absolute tw:inset-0 tw:w-full tw:h-full tw:object-contain tw:pointer-events-none" :alt="afterLabel" decoding="async" draggable="false" />
    <span class="compare-badge badge-after">{{ afterLabel }}</span>

    <!-- 顶层 (Before: 原图，根据 splitRatio 裁剪) -->
    <div ref="clippedLayer" class="compare-overlay tw:absolute tw:inset-0 tw:w-full tw:h-full tw:pointer-events-none">
      <div ref="clippedContent" class="compare-content tw:absolute tw:inset-0">
      <img v-if="before.src.value && !before.failed.value" v-bind="before.image.value" class="compare-img before-img tw:absolute tw:inset-0 tw:w-full tw:h-full tw:object-contain tw:pointer-events-none" :alt="beforeLabel" decoding="async" draggable="false" />
      <span class="compare-badge badge-before">{{ beforeLabel }}</span>
      </div>
    </div>

    <!-- 分割线与拖拽手柄 -->
    <div ref="divider" class="compare-divider tw:absolute tw:top-0 tw:bottom-0 tw:left-0 tw:w-[2px] tw:[background:color-mix(in_srgb,_var(--accent)_80%,_var(--text-primary))] tw:shadow-(--shadow-md) tw:pointer-events-none tw:[z-index:var(--z-overlay)]">
      <div class="compare-handle tw:absolute tw:top-1/2 tw:left-1/2 tw:flex tw:items-center tw:justify-center tw:gap-[2px] tw:w-[28px] tw:h-[28px] tw:rounded-full tw:bg-elevated tw:[border:1px_solid_var(--accent)] tw:text-accent tw:shadow-(--shadow-md) tw:text-body-sm tw:font-bold" aria-hidden="true">
        <ArchiveIcon name="compare" />
      </div>
    </div>
  </div>
  <!-- Recovery controls are outside the slider's presentational descendants. -->
  <div v-if="feedback.length" class="compare-feedback" role="status">
    <p v-for="item in feedback" :key="item.side">
      <span>{{ item.message }}</span>
      <button v-if="item.failed" type="button" @click="retry(item.side)">重新读取{{ item.label }}</button>
    </p>
  </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { useImageComparison } from '@/composables/useImageComparison'
import { useRuntimeImage } from '@/composables/useRuntimeImage'

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

const { position: splitPos, container: containerRef, clippedLayer, clippedContent, divider, isDragging, startDrag, onDrag, stopDrag, onKeydown } = useImageComparison(
  props.initialRatio * 100, 'left', value => `对比位置 ${value}%：${props.beforeLabel}与${props.afterLabel}`,
)
const before = useRuntimeImage(() => props.beforeSrc), after = useRuntimeImage(() => props.afterSrc)
const feedback = computed(() => ([
  { side: 'before' as const, label: props.beforeLabel, image: before },
  { side: 'after' as const, label: props.afterLabel, image: after },
]).flatMap(({ side, label, image }) => image.loaded.value ? [] : [{
  side, label, failed: image.failed.value,
  message: image.failed.value ? `${label}暂时无法读取` : image.src.value ? `正在读取${label}…` : `${label}暂无可用图片`,
}]))
function retry(side: 'before' | 'after') {
  containerRef.value?.focus({ preventScroll: true })
  ;(side === 'before' ? before : after).retry()
}
</script>

<style scoped>
.image-compare-slider { position:relative; width:100%; height:100%; min-width:0; min-height:0; border-radius:var(--r-md); background:var(--art-stage); }
.compare-surface:focus-visible {
  outline: none;
  box-shadow: var(--focus-shadow);
}
.image-compare-slider:hover .compare-handle {
  outline: none;
  box-shadow: var(--focus-shadow);
}
.compare-surface.is-dragging .compare-handle {
  transform: translate(-50%, -50%) scale(1.15);
  background: var(--accent);
  color: var(--text-inverse);
}

.compare-overlay {
  overflow: hidden;
  transform: translateX(-50%);
}
.compare-content { transform: translateX(50%); background:var(--art-stage); }

.compare-badge { position:absolute; bottom:var(--s-3); z-index:var(--z-raised); max-width:calc(100% - 2 * var(--s-3)); padding:var(--s-1) var(--s-2); border:1px solid var(--on-art-line); border-radius:var(--r-sm); background:var(--art-scrim); color:var(--on-art-primary); font:600 var(--fs-label-xs)/var(--lh-label) var(--font-sans); overflow-wrap:anywhere; pointer-events:none; }
.badge-before { left:var(--s-3); }
.badge-after { right:var(--s-3); }
.compare-feedback { position:absolute; inset:var(--s-3) var(--s-3) auto; z-index:var(--z-overlay); display:grid; gap:var(--s-2); max-height:calc(100% - 2 * var(--s-3)); overflow:auto; padding:var(--s-3); border:1px solid var(--border-soft); border-radius:var(--r-md); background:var(--bg-surface); color:var(--text-primary); font:400 var(--fs-label-sm)/var(--lh-body) var(--font-sans); }
.compare-feedback p { display:flex; align-items:center; justify-content:center; flex-wrap:wrap; gap:var(--s-2); margin:0; }
.compare-feedback button { min-height:var(--control-height-sm); padding:var(--s-1) var(--s-2); border:1px solid var(--border-soft); border-radius:var(--r-sm); background:var(--bg-elevated); color:var(--text-primary); font:inherit; cursor:pointer; }
.compare-feedback button:focus-visible { outline:none; box-shadow:var(--focus-shadow); }

.compare-divider {
  transform: translateX(calc(50cqw - 50%));
}

.compare-handle {
  transform: translate(-50%, -50%);
}
@media (forced-colors: active) {
  .compare-surface:focus-visible, .image-compare-slider:hover .compare-handle, .compare-feedback button:focus-visible { outline: 2px solid Highlight; outline-offset: -2px; }
  .compare-badge,.compare-feedback { background:Canvas; color:CanvasText; border-color:CanvasText; }
}
</style>
