<script setup lang="ts">
import { computed, useAttrs, useId } from 'vue'
import '@/assets/css/components/studio-slider.css'

defineOptions({ inheritAttrs: false })

const props = withDefaults(defineProps<{
  min?: number
  max?: number
  step?: number
  label?: string
  ariaLabel?: string
  unit?: string
  formatValue?: (value: number) => string
  valueText?: string
  showValue?: boolean
  minLabel?: string
  maxLabel?: string
  disabled?: boolean
  id?: string
  compact?: boolean
  character?: string
}>(), {
  min: 0,
  max: 100,
  step: 1,
  label: '',
  ariaLabel: '',
  unit: '',
  formatValue: undefined,
  valueText: undefined,
  showValue: undefined,
  minLabel: '',
  maxLabel: '',
  disabled: false,
  id: '',
  compact: false,
  character: '',
})

const modelValue = defineModel<number>({ required: true })
const emit = defineEmits<{ change: [value: number] }>()

const attrs = useAttrs()
const generatedId = useId()
const inputId = computed(() => props.id || generatedId)

const wrapperClass = computed(() => attrs.class)
const wrapperStyle = computed(() => attrs.style as Record<string, string> | string | undefined)
const inputAttrs = computed(() => {
  const { class: _class, style: _style, id: _id, ...rest } = attrs
  return rest
})

const progressPercent = computed(() => {
  const span = props.max - props.min
  if (!Number.isFinite(span) || span <= 0) return 0
  const clamped = Math.min(props.max, Math.max(props.min, modelValue.value))
  return ((clamped - props.min) / span) * 100
})

const displayValue = computed(() => {
  if (props.formatValue) return props.formatValue(modelValue.value)
  return `${modelValue.value}${props.unit}`
})

const computedValueText = computed(() => props.valueText ?? (props.unit || props.formatValue ? displayValue.value : undefined))
const shouldShowValue = computed(() => props.showValue ?? Boolean(props.label || props.unit || props.formatValue))

function onInput(event: Event) {
  const next = Number((event.target as HTMLInputElement).value)
  if (Number.isFinite(next)) modelValue.value = next
}

function onChange(event: Event) {
  const next = Number((event.target as HTMLInputElement).value)
  if (Number.isFinite(next)) emit('change', next)
}
</script>

<template>
  <div
    class="studio-slider"
    :class="[wrapperClass, { 'is-disabled': disabled, 'is-compact': compact }]"
    :style="wrapperStyle"
    :data-character="character || undefined"
  >
    <div v-if="label || $slots.label || shouldShowValue || $slots.value" class="studio-slider-header">
      <label v-if="label || $slots.label" class="studio-slider-label" :for="inputId">
        <slot name="label">{{ label }}</slot>
      </label>
      <output v-if="shouldShowValue || $slots.value" class="studio-slider-value" :for="inputId">
        <slot name="value" :value="modelValue" :formatted="displayValue">{{ displayValue }}</slot>
      </output>
    </div>

    <div class="studio-slider-row">
      <input
        :id="inputId"
        v-bind="inputAttrs"
        type="range"
        class="studio-slider-input"
        :class="{ 'studio-slider-compact': compact }"
        :min="min"
        :max="max"
        :step="step"
        :value="modelValue"
        :disabled="disabled"
        :aria-label="!label && !$slots.label ? (ariaLabel || undefined) : undefined"
        :aria-valuetext="computedValueText"
        :style="{ '--slider-progress': `${progressPercent}%` }"
        @input="onInput"
        @change="onChange"
      />
      <slot name="actions" />
    </div>

    <div v-if="minLabel || maxLabel" class="studio-slider-ends" aria-hidden="true">
      <span>{{ minLabel }}</span>
      <span>{{ maxLabel }}</span>
    </div>
  </div>
</template>
