<script setup lang="ts">
import { ref } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'

defineProps<{ checked: boolean; indeterminate?: boolean; disabled?: boolean; label: string }>()
const emit = defineEmits<{ 'update:checked': [checked: boolean] }>()
const input = ref<HTMLInputElement | null>(null)
defineExpose({ focus: (options?: FocusOptions) => input.value?.focus(options) })
</script>

<template>
  <label class="studio-checkbox" :class="{ 'is-disabled': disabled }">
    <input ref="input" class="studio-checkbox-input" type="checkbox" :checked="checked"
      :indeterminate.prop="!!indeterminate" :disabled="disabled" :aria-label="label"
      @change="emit('update:checked', ($event.target as HTMLInputElement).checked)" />
    <span class="studio-checkbox-box" aria-hidden="true">
      <span v-if="indeterminate" class="studio-checkbox-mixed"></span>
      <ArchiveIcon v-else-if="checked" name="success" />
    </span>
    <span v-if="$slots.default" class="studio-checkbox-label"><slot /></span>
  </label>
</template>

<style scoped>
.studio-checkbox { position:relative; display:inline-flex; align-items:center; gap:var(--s-2); min-width:calc(var(--control-height) + var(--s-1)); min-height:calc(var(--control-height) + var(--s-1)); padding:var(--s-1) var(--s-2); color:var(--text-primary); font:600 var(--fs-label-sm)/var(--lh-label) var(--font-sans); cursor:pointer; }
.studio-checkbox-input { position:absolute; inset:0; width:100%; height:100%; margin:0; opacity:0; cursor:inherit; }
.studio-checkbox-box { display:inline-flex; align-items:center; justify-content:center; flex:0 0 22px; width:22px; height:22px; border:1.5px solid var(--text-muted); border-radius:var(--r-xs); background:var(--bg-surface); color:var(--text-inverse); pointer-events:none; }
.studio-checkbox-input:checked + .studio-checkbox-box,
.studio-checkbox-input:indeterminate + .studio-checkbox-box { border-color:var(--accent); background:var(--accent); }
.studio-checkbox-input:focus-visible + .studio-checkbox-box { outline:2px solid var(--accent); outline-offset:3px; }
.studio-checkbox-box :deep(.archive-icon) { width:20px; height:20px; }
/* compositor-exempt: A one-shot 160ms stroke redraw in the 20px checkmark only;
   transform/opacity cannot draw its line. No loop or card-scale animation. */
.studio-checkbox-box :deep(path) { stroke-dasharray:24; stroke-dashoffset:0; animation:checkbox-draw var(--motion-hover) var(--ease-out); }
.studio-checkbox-mixed { width:12px; height:2px; border-radius:var(--r-pill); background:currentColor; transform-origin:left center; animation:checkbox-mixed var(--motion-hover) var(--ease-out); }
.studio-checkbox-label { pointer-events:none; }
.is-disabled { color:var(--text-disabled); cursor:not-allowed; }
.studio-checkbox-input:disabled + .studio-checkbox-box { border-color:var(--text-disabled); background:var(--bg-elevated); color:var(--text-disabled); }
@keyframes checkbox-draw { from { stroke-dashoffset:24; } to { stroke-dashoffset:0; } }
@keyframes checkbox-mixed { from { transform:scaleX(0); } to { transform:scaleX(1); } }
@media (prefers-reduced-motion:reduce) { .studio-checkbox-box :deep(path),.studio-checkbox-mixed { animation:none; } }
:root:is([data-motion='reduce'],[data-motion='reduced']) .studio-checkbox-box :deep(path),
:root:is([data-motion='reduce'],[data-motion='reduced']) .studio-checkbox-mixed { animation:none; }
@media (forced-colors:active) {
  .studio-checkbox-box { forced-color-adjust:none; color:CanvasText; background:Canvas; border-color:CanvasText; }
  .studio-checkbox-input:checked + .studio-checkbox-box,.studio-checkbox-input:indeterminate + .studio-checkbox-box { color:HighlightText; background:Highlight; border-color:Highlight; }
  .studio-checkbox-input:focus-visible + .studio-checkbox-box { outline-color:Highlight; }
  .studio-checkbox-input:disabled + .studio-checkbox-box { color:GrayText; background:Canvas; border-color:GrayText; }
}
</style>
