<template>
  <div class="director-resize-handle" :class="side" role="separator" tabindex="0" aria-orientation="vertical"
    :aria-label="side === 'materials' ? '调整素材栏宽度' : '调整参数栏宽度'" :aria-valuemin="side === 'materials' ? 240 : 280"
    :aria-valuemax="560" :aria-valuenow="Math.round(width)" :aria-valuetext="`${Math.round(width)} 像素`"
    @pointerdown="emit('start', $event)" @pointermove="emit('move', $event)" @pointerup="emit('finish', $event)"
    @pointercancel="emit('cancel', $event)" @lostpointercapture="emit('cancel', $event)" @keydown="emit('key', $event)"
    @click="emit('click', $event)" @dblclick="emit('reset', $event)" />
</template>
<script setup lang="ts">
import { onBeforeUnmount } from 'vue'
defineProps<{ side: 'materials' | 'inspector'; width: number }>()
const emit = defineEmits<{ start: [event: PointerEvent]; move: [event: PointerEvent]; finish: [event: PointerEvent]; cancel: [event?: PointerEvent]; click: [event: MouseEvent]; key: [event: KeyboardEvent]; reset: [event: MouseEvent] }>()
onBeforeUnmount(() => emit('cancel'))
</script>
<style scoped>
.director-resize-handle { display: none; }
@media (min-width: 1024px) {
  .director-resize-handle { display: block; position: absolute; z-index: var(--z-raised); top: 0; bottom: 0; width: 16px; cursor: col-resize; touch-action: none; }
  .director-resize-handle.materials { left: var(--director-material-width,clamp(260px,18vw,21rem)); }
  .director-resize-handle.inspector { right: var(--director-inspector-width,clamp(300px,24vw,26rem)); }
  .director-resize-handle::after { content: ''; position: absolute; inset: 20% 6px; border-radius: var(--r-pill); background: transparent; transition: background var(--motion-hover); }
  .director-resize-handle:hover::after, .director-resize-handle:focus-visible::after { background: var(--accent); }
  .director-resize-handle:focus-visible { outline: none; box-shadow: var(--focus-shadow); border-radius: var(--r-sm); }
}
</style>
