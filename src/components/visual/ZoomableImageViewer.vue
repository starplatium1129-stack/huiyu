<template>
  <div
    class="zoomable-image-viewer tw:relative tw:w-full tw:h-full tw:min-h-[280px] tw:flex tw:items-center tw:justify-center tw:overflow-hidden tw:select-none tw:cursor-zoom-in tw:touch-none"
    :class="{ 'is-zoomed': scale > 1.01, 'is-panning': isPanning }"
    role="group"
    tabindex="0"
    :aria-label="viewerLabel"
    @keydown="onKeydown"
    @wheel="onWheel"
    @pointerdown="startPan"
    @pointermove="onPan"
    @pointerup="stopPan"
    @pointercancel="stopPan"
    @lostpointercapture="stopPan"
    @dblclick="toggleZoom"
  >
    <div ref="viewportEl" class="zoom-viewport tw:relative tw:w-full tw:h-full tw:min-w-0 tw:min-h-0 tw:flex tw:items-center tw:justify-center tw:overflow-hidden">
    <div
      ref="transformEl"
      class="zoom-transform-layer tw:relative tw:w-full tw:h-full tw:flex tw:items-center tw:justify-center tw:min-w-0 tw:min-h-0"
    >
      <!-- 骨架屏占位 -->
      <div v-if="!imageReady && !imageFailed && !previewSrc" class="skeleton-placeholder tw:absolute tw:inset-0 tw:min-w-[240px] tw:min-h-[320px] tw:[border-radius:var(--r-lg,_12px)] tw:[background:var(--bg-elevated)]" aria-hidden="true"></div>

      <!-- 真实图片 -->
      <img v-if="displayedSrc" :key="`image:${imageRevision}`" :crossorigin="runtimeResourceCors()"
        v-show="!imageFailed"
        ref="imageEl"
        :data-image-attempt="imageAttempt"
        :src="requestSrc(displayedSrc, imageAttempt)"
        :alt="alt"
        class="zoomable-img tw:block tw:object-contain tw:[border-radius:var(--r-lg,_12px)]"
        :class="{ 'is-ready': imageReady || !!previewSrc }"
        draggable="false"
        @load="onImageLoad"
        @error="onImageError"
      />

      <!-- Decode the original offscreen while the already-loaded thumbnail stays visible. -->
      <img v-if="src && displayedSrc !== src && !fullImageFailed" :key="`full:${src}:${fullAttempt}`" ref="fullImageEl" :data-image-attempt="fullAttempt"
        :crossorigin="runtimeResourceCors()" :src="requestSrc(src, fullAttempt)" class="zoomable-preload tw:hidden"
        alt="" aria-hidden="true" @load="upgradeImage" @error="onFullImageError" />
    </div>
      <!-- 失败占位 -->
      <div v-if="imageFailed || (loadFailed && !displayedSrc)" class="image-fallback tw:absolute tw:inset-0 tw:flex tw:items-center tw:justify-center tw:[color:var(--on-art-secondary)] tw:text-label-sm">
        <slot name="fallback">
          <span>图片暂时无法读取</span>
        </slot>
      </div>
      <div v-if="loadFailed || fullImageFailed || imageFailed || retrying" class="zoom-recovery" role="status" @pointerdown.stop @dblclick.stop @wheel.stop>
        <span>{{ retrying ? '正在重新读取图片…' : imageReady && !imageFailed ? '高清图暂时无法读取，当前保留预览' : '图片暂时无法读取' }}</span>
        <button type="button" :disabled="retrying" @click.stop="retryImage">{{ retrying ? '读取中…' : imageReady && !imageFailed ? '重试高清' : '重新读取' }}</button>
      </div>
    </div>

    <!-- 缩放控制始终可见，键盘和触摸用户不必先猜测手势。 -->
    <div class="zoom-toolbar" @pointerdown.stop @dblclick.stop @wheel.stop>
    <div data-fluid-glass class="zoom-controls tw:absolute tw:bottom-[12px] tw:left-1/2 tw:flex tw:items-center tw:gap-[6px] tw:p-[4px] tw:rounded-md tw:[background:color-mix(in_srgb,_var(--bg-deep)_84%,_transparent)] tw:border tw:border-solid tw:border-soft tw:[z-index:var(--z-raised)] tw:text-label-sm tw:text-primary" role="group" aria-label="图片缩放控制" @pointerdown.stop @dblclick.stop>
      <span class="zoom-level tw:[margin:0_4px] tw:[font-family:var(--font-mono,_monospace)] tw:font-semibold tw:[color:var(--archive-blue)]" aria-live="polite">{{ Math.round(scale * 100) }}%</span>
      <button type="button" class="zoom-control tw:grid tw:place-items-center tw:w-[36px] tw:h-[36px] tw:p-0 tw:border tw:border-solid tw:border-transparent tw:rounded-sm tw:[background:color-mix(in_srgb,_var(--bg-elevated)_78%,_transparent)] tw:text-primary tw:cursor-pointer" aria-label="放大图片" @pointerdown.stop @click.stop="zoomIn">
        <ArchiveIcon name="expand" />
      </button>
      <button type="button" class="zoom-control tw:grid tw:place-items-center tw:w-[36px] tw:h-[36px] tw:p-0 tw:border tw:border-solid tw:border-transparent tw:rounded-sm tw:[background:color-mix(in_srgb,_var(--bg-elevated)_78%,_transparent)] tw:text-primary tw:cursor-pointer" aria-label="缩小图片" @pointerdown.stop @click.stop="zoomOut">
        <ArchiveIcon name="compress" />
      </button>
      <button type="button" class="zoom-control btn-reset-zoom tw:grid tw:place-items-center tw:w-[36px] tw:h-[36px] tw:p-0 tw:border tw:border-solid tw:border-transparent tw:rounded-sm tw:[background:color-mix(in_srgb,_var(--bg-elevated)_78%,_transparent)] tw:text-primary tw:cursor-pointer" aria-label="还原图片缩放" @pointerdown.stop @click.stop="resetZoom">
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
import { runtimeResourceCors } from '@/platform/runtimeUrl'

import { computed, ref } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { useImageViewport } from '@/composables/useImageViewport'
import { useViewerImage } from '@/composables/useViewerImage'

const props = defineProps<{
  src: string
  /** An already-visible, unrestricted thumbnail; it keeps the first frame continuous. */
  previewSrc?: string
  alt?: string
  minScale?: number
  maxScale?: number
  imageKey?: string | number
  /** Let a surrounding gallery handle wheel input over the image's letterboxing. */
  wheelOnImageOnly?: boolean
  loadFailed?: boolean
  reload?: () => Promise<void>
}>()

const emit = defineEmits<{
  (e: 'load'): void
  (e: 'error'): void
}>()

const viewportEl = ref<HTMLElement | null>(null)
const transformEl = ref<HTMLElement | null>(null)
const { imageEl, fullImageEl, displayedSrc, fullImageFailed, imageAttempt, fullAttempt, imageRevision, retrying, imageReady, imageFailed,
  requestSrc, onImageLoad, onImageError, upgradeImage, onFullImageError, retryImage } = useViewerImage(props, {
  loaded: () => { refreshBounds(); emit('load') }, error: () => emit('error'), reset: () => resetImage(),
  focus: () => viewportEl.value?.parentElement?.focus({ preventScroll:true }),
})

const { scale, isPanning, refreshBounds, resetZoom, resetImage, zoomIn, zoomOut, toggleZoom,
  containsImagePoint, handleWheel, onKeydown, startPan, onPan, stopPan } = useImageViewport(viewportEl, imageEl, transformEl, props)
function onWheel(event: WheelEvent) {
  if (props.wheelOnImageOnly && !containsImagePoint(event)) return
  event.preventDefault()
  event.stopPropagation()
  handleWheel(event)
}
const viewerLabel = computed(() => props.alt ? `${props.alt}查看器` : '图片查看器')
</script>

<style scoped>
.zoomable-image-viewer:focus-visible {
  outline: none;
  box-shadow: var(--focus-shadow);
}

.zoomable-image-viewer.is-zoomed {
  cursor: grab;
}

.zoomable-image-viewer.is-panning {
  cursor: grabbing;
}

.zoom-transform-layer {
  transform-origin: center center;
  /* Wheel, keyboard and drag follow the input directly, without queued zoom. */
}

/* The content always fits this viewport, including low-resolution previews.
   Keep the element box stable when the decoded original replaces its preview. */
.zoom-transform-layer > .zoomable-img {
  width: 100%;
  height: 100%;
  max-width: 100%;
  max-height: 100%;
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
.zoom-recovery { --text-disabled:var(--on-art-secondary); position:absolute; inset:var(--s-3) var(--s-3) auto; z-index:var(--z-raised); display:flex; align-items:center; justify-content:center; flex-wrap:wrap; gap:var(--s-2); padding:var(--s-2); border-radius:var(--r-sm); background:var(--art-scrim); color:var(--on-art-primary); font-size:var(--fs-label-sm); }
.zoom-recovery button { min-height:var(--control-height-sm); padding:var(--s-1) var(--s-2); border:1px solid var(--on-art-line); border-radius:var(--r-sm); background:transparent; color:inherit; font:inherit; cursor:pointer; }
.zoom-recovery button:disabled { color:var(--text-disabled); cursor:wait; }
.zoom-recovery button:focus-visible { outline:2px solid var(--on-art-primary); outline-offset:2px; }

@media (hover: hover) and (pointer: fine) {
  .zoom-control:hover {
    border-color: color-mix(in srgb, var(--accent) 48%, var(--border-soft));
    background: var(--accent-soft);
    color: var(--accent);
  }
}

.zoom-control:focus-visible {
  outline: none;
  box-shadow: var(--focus-shadow);
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
  :root:not([data-motion='full']) .zoomable-img { transition:opacity var(--motion-press) var(--ease-out); }
}
:root:is([data-motion='reduce'], [data-motion='reduced']) .zoomable-img { transition:opacity var(--motion-press) var(--ease-out); }
</style>
