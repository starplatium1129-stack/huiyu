<template>
  <SwitchRoot class="toggle-switch"
      :model-value="modelValue"
      :disabled="disabled"
      :aria-label="label || undefined"
      @update:model-value="onChange"
    >
    <span class="toggle-slider" aria-hidden="true"><SwitchThumb class="toggle-knob" /></span>
    <slot />
  </SwitchRoot>
</template>

<script setup lang="ts">
import { SwitchRoot, SwitchThumb } from 'reka-ui'
withDefaults(defineProps<{
  modelValue: boolean
  disabled?: boolean
  /** 无文本时的无障碍标签 */
  label?: string
}>(), { disabled: false, label: '' })

const emit = defineEmits<{
  (event: 'update:modelValue', value: boolean): void
  (event: 'change', value: boolean): void
}>()

function onChange(value: boolean) {
  emit('update:modelValue', value)
  emit('change', value)
}
</script>

<style scoped>
.toggle-switch {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 0;
  border: 0;
  background: transparent;
  text-align: start;
  cursor: pointer;
  color: inherit;
  font: inherit;
  line-height: var(--lh-flush);
  flex-shrink: 0;
}
.toggle-slider {
  position: relative;
  display: inline-block;
  width: 32px;
  height: 18px;
  flex-shrink: 0;
  background: var(--border-strong);
  border-radius: var(--r-pill);
}
.toggle-knob {
  position: absolute;
  height: 13px;
  width: 13px;
  left: 2.5px;
  bottom: 2.5px;
  background: var(--text-primary);
  border-radius: 50%;
  transform: translateX(0);
  transition: transform var(--motion-hover) var(--ease-out);
}
.toggle-switch[data-state='checked'] .toggle-slider {
  background: var(--accent);
}
.toggle-knob[data-state='checked'] { transform: translateX(14px); background: var(--text-inverse); }
.toggle-switch:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.toggle-switch[data-disabled] {
  /* 审计修复：不用 opacity 压控件（非文字 3:1 也压没了），改用禁用令牌 */
  cursor: not-allowed;
  color: var(--text-disabled);
}
.toggle-switch[data-disabled] .toggle-slider {
  background: var(--bg-elevated);
  box-shadow: inset 0 0 0 1px var(--border-soft);
}
.toggle-switch[data-disabled] .toggle-knob {
  background: var(--text-disabled);
}
@media (prefers-reduced-motion: reduce) { .toggle-knob { transition: none; } }
@media (forced-colors: active) {
  .toggle-slider { background: Canvas; outline: 1px solid ButtonText; }
  .toggle-knob { background: ButtonText; }
  .toggle-switch[data-state='checked'] .toggle-slider { background: Highlight; }
  .toggle-knob[data-state='checked'] { background: HighlightText; }
  .toggle-switch[data-disabled] .toggle-knob { background: GrayText; }
}
</style>
