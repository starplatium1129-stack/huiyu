<template>
  <fieldset class="model-calibration-fields" :disabled="disabled || !parameters.length">
    <legend>{{ title }}</legend>
    <label>{{ title }}参数
      <select :value="binding.id" :disabled="!parameters.length" @change="$emit('update', { ...binding, id: ($event.target as HTMLSelectElement).value }, true)">
        <option value="">不覆写，保留作者动画</option>
        <option v-for="parameter in parameters" :key="parameter.id" :value="parameter.id">{{ parameter.id }}</option>
      </select>
    </label>
    <template v-if="binding.id">
      <p v-if="range">实际范围 {{ range.min }} ～ {{ range.max }} · 默认 {{ range.default }}</p>
      <div class="model-endpoints">
        <label>闭合值 <input :value="binding.closed" type="number" step="any" :min="range?.min" :max="range?.max" :aria-label="`${title}闭合值`" @input="$emit('update', { ...binding, closed: ($event.target as HTMLInputElement).valueAsNumber }, false)" /></label>
        <label>张开值 <input :value="binding.open" type="number" step="any" :min="range?.min" :max="range?.max" :aria-label="`${title}张开值`" @input="$emit('update', { ...binding, open: ($event.target as HTMLInputElement).valueAsNumber }, false)" /></label>
      </div>
    </template>
  </fieldset>
</template>
<script setup lang="ts">
import { computed } from 'vue'
import type { CalibrationBinding, ModelParameter } from '@/live2d/modelCalibration'
const props = defineProps<{ title: string; binding: CalibrationBinding; parameters: ModelParameter[]; disabled?: boolean }>()
defineEmits<{ update: [value: CalibrationBinding, select: boolean] }>()
const range = computed(() => props.parameters.find(item => item.id === props.binding.id))
</script>
