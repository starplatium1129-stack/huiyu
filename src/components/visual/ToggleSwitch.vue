<template>
  <SwitchRoot class="toggle-switch"
      :class="{ 'toggle-switch-icon-only': !hasSlotContent }"
      :model-value="modelValue"
      :disabled="disabled"
      :aria-label="label || undefined"
      @update:model-value="onChange"
    >
    <span ref="slider" class="toggle-slider" aria-hidden="true">
      <span ref="fill" class="toggle-fill" />
      <SwitchThumb class="toggle-knob">
        <span class="toggle-knob-surface" />
        <ArchiveIcon class="toggle-off" name="minus" />
        <ArchiveIcon class="toggle-on" name="success" />
      </SwitchThumb>
    </span>
    <slot />
  </SwitchRoot>
</template>

<script setup lang="ts">
import { computed, ref, useSlots } from 'vue'
import { SwitchRoot, SwitchThumb } from 'reka-ui'
import ArchiveIcon from './ArchiveIcon.vue'
import { useToggleMotion } from '@/composables/useToggleMotion'

const slots = useSlots()
const hasSlotContent = computed(() => Boolean(slots.default))

const props = withDefaults(defineProps<{
  modelValue: boolean
  disabled?: boolean
  /** 无文本时的无障碍标签 */
  label?: string
}>(), { disabled: false, label: '' })

const slider = ref<HTMLElement | null>(null)
const fill = ref<HTMLElement | null>(null)
useToggleMotion(() => props.modelValue, progress => {
  const knob = slider.value?.lastElementChild as HTMLElement | undefined
  const off = knob?.children[1] as SVGElement | undefined
  const on = knob?.children[2] as SVGElement | undefined
  const opacity = Math.max(0, Math.min(1, progress))
  if (knob) knob.style.transform = `translateX(${16 * progress}px)`
  if (fill.value) fill.value.style.opacity = String(opacity)
  if (off) { off.style.opacity = String(1 - opacity); off.style.transform = `scale(${1 - .2 * progress})` }
  if (on) { on.style.opacity = String(opacity); on.style.transform = `scale(${.6 + .4 * progress}) rotate(${-30 * (1 - progress)}deg)` }
})

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
