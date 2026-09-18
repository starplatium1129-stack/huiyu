<template>
  <label class="toggle-switch" :class="{ 'is-disabled': disabled }">
    <input
      type="checkbox"
      :checked="modelValue"
      :disabled="disabled"
      :aria-label="label || undefined"
      @change="onChange"
    />
    <span class="toggle-slider" aria-hidden="true"><span ref="knob" class="toggle-knob"></span></span>
    <slot />
  </label>
</template>

<script setup lang="ts">
import { onActivated, onDeactivated, onMounted, onUnmounted, ref, watch } from 'vue'
import { createFluidMotion } from '@/utils/fluidSpring'
const props = withDefaults(defineProps<{
  modelValue: boolean
  disabled?: boolean
  /** 无文本时的无障碍标签 */
  label?: string
}>(), { disabled: false, label: '' })

const emit = defineEmits<{
  (event: 'update:modelValue', value: boolean): void
  (event: 'change', value: boolean): void
}>()

function onChange(event: Event) {
  const value = (event.target as HTMLInputElement).checked
  emit('update:modelValue', value)
  emit('change', value)
}
const knob = ref<HTMLElement | null>(null)
let motion: ReturnType<typeof createFluidMotion> | undefined
function start() {
  if (motion) return
  motion = createFluidMotion([props.modelValue ? 14 : 0], ([x]) => { if (knob.value) knob.value.style.transform = `translateX(${x}px)` }, 5.5)
  motion.to([props.modelValue ? 14 : 0], true)
}
function stop() { motion?.dispose(); motion = undefined }
onMounted(start)
onActivated(start)
onDeactivated(stop)
watch(() => props.modelValue, value => motion?.to([value ? 14 : 0]))
onUnmounted(stop)
</script>

<style scoped>
.toggle-switch {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  color: inherit;
  font-size: inherit;
  line-height: var(--lh-flush);
  flex-shrink: 0;
}
.toggle-switch input {
  /* 透明但铺满整个开关：保持原生 input 可点/可聚焦（Playwright check() 可达、
     触屏命中区更大），视觉仍由 .toggle-slider 呈现。width/height 0 会让
     自动化与辅助技术判定元素不可交互。 */
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  opacity: 0;
  cursor: pointer;
}
.toggle-slider {
  position: relative;
  display: inline-block;
  width: 32px;
  height: 18px;
  flex-shrink: 0;
  background: var(--border-soft);
  border-radius: var(--r-pill);
  transition: background var(--motion-hover), box-shadow var(--motion-hover);
}
.toggle-knob {
  position: absolute;
  height: 13px;
  width: 13px;
  left: 2.5px;
  bottom: 2.5px;
  background: var(--text-primary);
  border-radius: 50%;
  transition: background var(--motion-hover);
}
.toggle-switch input:checked + .toggle-slider {
  background: var(--accent);
}
.toggle-switch input:focus-visible + .toggle-slider {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.toggle-switch.is-disabled {
  /* 审计修复：不用 opacity 压控件（非文字 3:1 也压没了），改用禁用令牌 */
  cursor: not-allowed;
}
.toggle-switch.is-disabled .toggle-slider {
  background: var(--bg-elevated);
  box-shadow: inset 0 0 0 1px var(--border-soft);
}
.toggle-switch.is-disabled .toggle-knob {
  background: var(--text-disabled);
}
</style>
