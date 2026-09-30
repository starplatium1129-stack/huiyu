<template>
  <div ref="stage" class="candidate-viewport" role="group" tabindex="0"
    :aria-label="`${title}对比画面，加减键缩放、方向键移动、Home 复位`" :data-zoomed="pose.scale > 1 || undefined"
    @wheel.prevent="wheel" @keydown="keydown" @dblclick="zoom(pose.scale > 1 ? 1 : 2)"
    @pointerdown="startPan" @pointermove="pan" @pointerup="stopPan" @pointercancel="stopPan" @lostpointercapture="stopPan">
    <img v-if="src" :src="resolveRuntimeUrl(src)" :crossorigin="runtimeResourceCors()" :alt="title" draggable="false" :style="{ '--candidate-transform': `translate(${pose.x * 100}%,${pose.y * 100}%) scale(${pose.scale})` }" />
    <span v-else>{{ loading ? '正在读取原图…' : '原图暂不可用，作品记录仍保留' }}</span>
  </div>
</template>
<script setup lang="ts">
import { onUnmounted, ref, watch } from 'vue'
import { resolveRuntimeUrl, runtimeResourceCors } from '@/platform/runtimeUrl'
import { clampCandidatePose, type CandidatePose } from '@/composables/gallery/useCandidateViewport'
const props = defineProps<{ src: string; title: string; pose: CandidatePose; loading: boolean }>()
const emit = defineEmits<{ change: [pose: CandidatePose] }>()
const stage = ref<HTMLElement | null>(null)
let drag: { pointer: number; x: number; y: number; width: number; height: number; pose: CandidatePose } | null = null
function zoom(scale: number, anchor = { x: 0, y: 0 }) {
  const next = Math.min(4, Math.max(1, scale)), ratio = next / props.pose.scale
  emit('change', clampCandidatePose({ scale: next, x: anchor.x - (anchor.x - props.pose.x) * ratio, y: anchor.y - (anchor.y - props.pose.y) * ratio }))
}
function wheel(event: WheelEvent) {
  const box = stage.value!.getBoundingClientRect()
  zoom(props.pose.scale * (event.deltaY < 0 ? 1.15 : 1 / 1.15), { x: (event.clientX - box.left) / Math.max(box.width, 1) - .5, y: (event.clientY - box.top) / Math.max(box.height, 1) - .5 })
}
function keydown(event: KeyboardEvent) {
  if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return
  if (['+', '=', '-', '_', 'Home', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) event.preventDefault()
  if (event.key === '+' || event.key === '=') zoom(props.pose.scale * 1.25)
  else if (event.key === '-' || event.key === '_') zoom(props.pose.scale / 1.25)
  else if (event.key === 'Home') emit('change', { scale: 1, x: 0, y: 0 })
  else if (event.key.startsWith('Arrow')) emit('change', clampCandidatePose({ ...props.pose,
    x: props.pose.x + (event.key === 'ArrowLeft' ? -.08 : event.key === 'ArrowRight' ? .08 : 0),
    y: props.pose.y + (event.key === 'ArrowUp' ? -.08 : event.key === 'ArrowDown' ? .08 : 0) }))
}
function startPan(event: PointerEvent) {
  if (event.button !== 0 || props.pose.scale <= 1) return
  const box = stage.value!.getBoundingClientRect()
  drag = { pointer: event.pointerId, x: event.clientX, y: event.clientY, width: Math.max(box.width, 1), height: Math.max(box.height, 1), pose: { ...props.pose } }
  stage.value?.setPointerCapture?.(event.pointerId); event.preventDefault()
}
function pan(event: PointerEvent) {
  if (!drag || event.pointerId !== drag.pointer) return
  emit('change', clampCandidatePose({ ...drag.pose, x: drag.pose.x + (event.clientX - drag.x) / drag.width, y: drag.pose.y + (event.clientY - drag.y) / drag.height }))
}
function stopPan() {
  const pointer = drag?.pointer
  drag = null
  if (pointer !== undefined && stage.value?.hasPointerCapture?.(pointer)) stage.value.releasePointerCapture(pointer)
}
watch(() => props.src, stopPan)
onUnmounted(stopPan)
</script>
<style scoped>
@reference "../../assets/css/tailwind.css";
.candidate-viewport { @apply tw:relative tw:flex tw:items-center tw:justify-center tw:rounded-md tw:overflow-hidden tw:text-secondary tw:text-label tw:select-none; height:min(48dvh,480px); background:var(--bg-base); touch-action:none; cursor:zoom-in; }
.candidate-viewport[data-zoomed="true"] { cursor:grab; }
.candidate-viewport[data-zoomed="true"]:active { cursor:grabbing; }
.candidate-viewport img { @apply tw:block tw:w-full tw:h-full tw:object-contain; transform:var(--candidate-transform); }
.candidate-viewport:focus-visible { outline:2px solid var(--accent); outline-offset:-2px; }
</style>
