<script setup lang="ts">
import { computed, ref, useAttrs } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'

defineOptions({ inheritAttrs: false })

defineProps<{ checked: boolean; indeterminate?: boolean; disabled?: boolean; label: string }>()
const emit = defineEmits<{ 'update:checked': [checked: boolean] }>()

const attrs = useAttrs()
const input = ref<HTMLInputElement | null>(null)

const wrapperClass = computed(() => attrs.class)
const wrapperStyle = computed(() => attrs.style as Record<string, string> | string | undefined)
const inputAttrs = computed(() => {
  const { class: _class, style: _style, ...rest } = attrs
  return rest
})

defineExpose({ focus: (options?: FocusOptions) => input.value?.focus(options) })
</script>

<template>
  <label class="studio-checkbox" :class="[wrapperClass, { 'is-disabled': disabled }]" :style="wrapperStyle">
    <input
      ref="input"
      v-bind="inputAttrs"
      class="studio-checkbox-input"
      type="checkbox"
      :checked="checked"
      :indeterminate.prop="!!indeterminate"
      :disabled="disabled"
      :aria-label="label"
      @change="emit('update:checked', ($event.target as HTMLInputElement).checked)"
    />
    <span class="studio-checkbox-box" aria-hidden="true">
      <span v-if="indeterminate" class="studio-checkbox-mixed"></span>
      <ArchiveIcon v-else-if="checked" name="success" />
    </span>
    <span v-if="$slots.default" class="studio-checkbox-label"><slot /></span>
  </label>
</template>

<style scoped>
.studio-checkbox {
  position: relative;
  display: inline-grid;
  grid-template-columns: 20px minmax(0, 1fr);
  align-items: start;
  align-content: center;
  gap: var(--s-2);
  min-width: calc(var(--control-height) + var(--s-1));
  max-width: 100%;
  min-height: calc(var(--control-height) + var(--s-1));
  padding: var(--s-1) var(--s-2);
  color: var(--text-primary);
  font: 600 var(--fs-label-sm) / var(--lh-label) var(--font-sans);
  cursor: pointer;
  user-select: none;
}

.studio-checkbox-input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  opacity: 0;
  cursor: inherit;
}

.studio-checkbox-box {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 20px;
  width: 20px;
  height: 20px;
  margin-top: 1px;
  border: 1.5px solid var(--border-strong);
  border-radius: var(--r-xs);
  background: var(--bg-surface);
  color: var(--text-primary);
  box-shadow: inset 0 1px 0 var(--glass-highlight);
  pointer-events: none;
  transition: transform var(--control-feedback-duration, var(--motion-hover)) var(--spring-soft);
}

@media (hover: hover) and (pointer: fine) {
  .studio-checkbox:not(.is-disabled):not(:has(:focus-visible)):hover .studio-checkbox-box {
    border-color: var(--text-secondary);
    transform: scale(var(--control-feedback-zoom, 1.08));
  }
}

.studio-checkbox:not(.is-disabled):not(:has(:focus-visible)):active .studio-checkbox-box {
  transform: scale(var(--control-feedback-press, .92));
  transition-duration: var(--control-feedback-duration, var(--motion-press));
}

.studio-checkbox-input:checked + .studio-checkbox-box,
.studio-checkbox-input:indeterminate + .studio-checkbox-box {
  border-color: var(--text-primary);
  background: var(--text-primary);
  color: var(--text-inverse);
}

.studio-checkbox-input:focus-visible + .studio-checkbox-box {
  outline: 2px solid var(--focus-color, var(--text-secondary));
  outline-offset: 2px;
  transform: none;
  transition: none;
}

.studio-checkbox-box :deep(.archive-icon) {
  width: 15px;
  height: 15px;
  stroke-width: 2.2;
}

/* compositor-exempt: A one-shot 160ms stroke redraw in the 15px checkmark only;
   transform/opacity cannot draw its line. No loop or card-scale animation. */
.studio-checkbox-box :deep(path) {
  stroke-dasharray: 24;
  stroke-dashoffset: 0;
  animation: checkbox-draw var(--motion-hover) var(--ease-out);
}

.studio-checkbox-mixed {
  width: 10px;
  height: 2px;
  border-radius: var(--r-pill);
  background: currentColor;
  transform-origin: left center;
  animation: checkbox-mixed var(--motion-hover) var(--ease-out);
}

.studio-checkbox-label {
  min-width: 0;
  overflow-wrap: anywhere;
  pointer-events: none;
}

.is-disabled {
  color: var(--text-disabled);
  cursor: not-allowed;
}

.studio-checkbox-input:disabled + .studio-checkbox-box {
  border-color: var(--border-soft);
  background: var(--bg-base);
  color: var(--text-disabled);
  box-shadow: none;
}

.studio-checkbox-input:disabled:is(:checked, :indeterminate) + .studio-checkbox-box {
  border-color: var(--border-strong);
  background: var(--bg-elevated);
  color: var(--text-disabled);
}

@keyframes checkbox-draw {
  from { stroke-dashoffset: 24; }
  to { stroke-dashoffset: 0; }
}

@keyframes checkbox-mixed {
  from { transform: scaleX(0); }
  to { transform: scaleX(1); }
}

@media (prefers-reduced-motion: reduce) {
  :root:not([data-motion='full']) .studio-checkbox {
    --control-feedback-duration: 0s;
    --control-feedback-zoom: 1;
    --control-feedback-press: 1;
  }

  :root:not([data-motion='full']) .studio-checkbox-box :deep(path),
  :root:not([data-motion='full']) .studio-checkbox-mixed {
    animation: none;
  }
}

:root:is([data-motion='reduce'], [data-motion='reduced'], [data-reduced-motion='true']) .studio-checkbox {
  --control-feedback-duration: 0s;
  --control-feedback-zoom: 1;
  --control-feedback-press: 1;
}

:root:is([data-motion='reduce'], [data-motion='reduced'], [data-reduced-motion='true']) .studio-checkbox-box :deep(path),
:root:is([data-motion='reduce'], [data-motion='reduced'], [data-reduced-motion='true']) .studio-checkbox-mixed {
  animation: none;
}

@media (forced-colors: active) {
  .studio-checkbox-box {
    forced-color-adjust: none;
    color: CanvasText;
    background: Canvas;
    border-color: CanvasText;
  }

  .studio-checkbox-input:checked + .studio-checkbox-box,
  .studio-checkbox-input:indeterminate + .studio-checkbox-box {
    color: HighlightText;
    background: Highlight;
    border-color: Highlight;
  }

  .studio-checkbox-input:focus-visible + .studio-checkbox-box {
    outline: 2px solid Highlight;
    outline-offset: 2px;
  }

  .studio-checkbox-input:disabled + .studio-checkbox-box {
    color: GrayText;
    background: Canvas;
    border-color: GrayText;
  }
}
</style>
