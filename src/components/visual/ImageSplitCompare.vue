<template>
  <div
    ref="containerEl"
    class="image-split-compare"
    :class="{ 'is-dragging': isDragging }"
    role="slider"
    tabindex="0"
    :aria-label="comparisonLabel"
    aria-orientation="horizontal"
    :aria-valuenow="splitPos"
    :aria-valuetext="splitValueText"
    aria-valuemin="0"
    aria-valuemax="100"
    @keydown="onKeydown"
    @pointerdown="startDrag"
    @pointermove="onDrag"
    @pointerup="stopDrag"
    @pointercancel="stopDrag"
  >
    <!-- Before Image (Base layer) -->
    <div class="split-layer layer-before">
      <img :src="beforeSrc" :alt="beforeLabel || '原图'" class="split-img" draggable="false" />
      <span class="split-badge badge-before">{{ beforeLabel || '换装前' }}</span>
    </div>

    <!-- After Image (Clipped overlay) -->
    <div
      class="split-layer layer-after"
      :style="splitLayerStyle"
    >
      <img :src="afterSrc" :alt="afterLabel || '换装后'" class="split-img" draggable="false" />
      <span class="split-badge badge-after">{{ afterLabel || '换装后' }}</span>
    </div>

    <!-- Split Divider Handle -->
    <div
      class="split-divider"
      :style="dividerStyle"
      aria-hidden="true"
    >
      <div class="divider-line"></div>
      <div class="divider-handle">
        <ArchiveIcon name="compare" class="divider-icon" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'

const props = defineProps<{
  beforeSrc: string
  afterSrc: string
  beforeLabel?: string
  afterLabel?: string
  initialPos?: number
}>()

function clampPos(value: number) {
  if (!Number.isFinite(value)) return 50
  return Math.max(0, Math.min(100, Math.round(value)))
}

const splitPos = ref(clampPos(props.initialPos ?? 50))
const beforeName = computed(() => props.beforeLabel || '原图')
const afterName = computed(() => props.afterLabel || '换装后')
const comparisonLabel = computed(() => `左右对比滑动条：${beforeName.value}与${afterName.value}`)
const splitValueText = computed(() => `对比位置 ${splitPos.value}%：${beforeName.value}与${afterName.value}`)
const isDragging = ref(false)
const containerEl = ref<HTMLElement | null>(null)

// 自定义属性载体：样式规则留在 scoped CSS，内联只承载数据（style-debt 门禁约定）
const splitLayerStyle = computed(() => ({
  '--split-clip': `polygon(${splitPos.value}% 0, 100% 0, 100% 100%, ${splitPos.value}% 100%)`,
}))
const dividerStyle = computed(() => ({
  '--split-pos': `${splitPos.value}%`,
}))

function updatePosFromEvent(event: PointerEvent) {
  if (!containerEl.value) return
  const rect = containerEl.value.getBoundingClientRect()
  if (!rect.width) return
  const offsetX = event.clientX - rect.left
  const clampedX = Math.max(0, Math.min(rect.width, offsetX))
  splitPos.value = Math.round((clampedX / rect.width) * 100)
}

function startDrag(event: PointerEvent) {
  isDragging.value = true
  containerEl.value?.focus({ preventScroll: true })
  event.currentTarget instanceof HTMLElement && event.currentTarget.setPointerCapture(event.pointerId)
  updatePosFromEvent(event)
}

function onDrag(event: PointerEvent) {
  if (isDragging.value) {
    updatePosFromEvent(event)
  }
}

function stopDrag(event: PointerEvent) {
  if (isDragging.value) {
    isDragging.value = false
    try {
      event.currentTarget instanceof HTMLElement && event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {}
  }
}

function onKeydown(event: KeyboardEvent) {
  let next: number | null = null
  if (event.key === 'ArrowLeft') next = splitPos.value - 1
  else if (event.key === 'ArrowRight') next = splitPos.value + 1
  else if (event.key === 'PageDown') next = splitPos.value - 10
  else if (event.key === 'PageUp') next = splitPos.value + 10
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = 100
  if (next === null) return
  event.preventDefault()
  splitPos.value = clampPos(next)
}
</script>

<style scoped>
.image-split-compare {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  user-select: none;
  touch-action: none;
  cursor: ew-resize;
  border-radius: var(--r-sm);
  background: var(--bg-deep);
}

.image-split-compare:focus-visible {
  outline: 2px solid var(--archive-blue);
  outline-offset: -2px;
}

.split-layer {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

.layer-after {
  clip-path: var(--split-clip, polygon(50% 0, 100% 0, 100% 100%, 50% 100%));
}

.split-img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
}

.split-badge {
  position: absolute;
  top: 10px;
  font-size: var(--fs-label-xs);
  padding: 3px 8px;
  border-radius: var(--r-xs);
  backdrop-filter: blur(6px);
  z-index: var(--z-canvas);
  font-weight: 500;
}

.badge-before {
  left: 10px;
  background: color-mix(in srgb, black 70%, transparent);
  color: color-mix(in srgb, white 85%, transparent);
  border: 1px solid color-mix(in srgb, white 15%, transparent);
}

.badge-after {
  right: 10px;
  background: rgba(56, 189, 248, 0.2);
  color: var(--archive-blue);
  border: 1px solid rgba(56, 189, 248, 0.4);
}

.split-divider {
  position: absolute;
  top: 0;
  bottom: 0;
  left: var(--split-pos, 50%);
  width: 2px;
  transform: translateX(-50%);
  z-index: 5;
  pointer-events: none;
}

.divider-line {
  position: absolute;
  inset: 0;
  background: var(--archive-blue);
  box-shadow: 0 0 8px rgba(56, 189, 248, 0.6);
}

.divider-handle {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--bg-deep);
  border: 2px solid var(--archive-blue);
  box-shadow: 0 2px 8px color-mix(in srgb, black 70%, transparent);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--archive-blue);
}

.divider-icon {
  font-size: var(--fs-label-sm);
}

.is-dragging .divider-handle {
  transform: translate(-50%, -50%) scale(1.15);
  background: var(--archive-blue);
  color: var(--bg-deep);
}
</style>
