<template>
  <SwitchRoot class="toggle-switch"
      :class="{ 'toggle-switch-icon-only': !hasSlotContent }"
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
import { computed, useSlots } from 'vue'
import { SwitchRoot, SwitchThumb } from 'reka-ui'

const slots = useSlots()
const hasSlotContent = computed(() => Boolean(slots.default))

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

<style scoped src="@/assets/css/components/visual/ToggleSwitch-0.css"></style>
