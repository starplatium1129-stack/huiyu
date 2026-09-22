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

<style scoped>
.model-calibration-fields select {
  width: 100%;
  min-height: 40px;
  padding: var(--s-2) var(--s-7) var(--s-2) var(--s-3);
  border: 1px solid var(--border-soft);
  border-radius: var(--r-md);
  background-color: var(--bg-surface);
  color: var(--text-primary);
  font: inherit;
  cursor: pointer;
  outline: none;
  -webkit-appearance: none;
  appearance: none;
  background-image:
    linear-gradient(45deg, transparent 50%, var(--text-muted) 50%),
    linear-gradient(135deg, var(--text-muted) 50%, transparent 50%);
  background-repeat: no-repeat;
  background-position:
    calc(100% - 14px) calc(50% - 1px),
    calc(100% - 10px) calc(50% - 1px);
  background-size: 5px 5px;
  transition: border-color var(--motion-hover) var(--ease-out);
}
.model-calibration-fields select:hover { border-color: var(--accent); }
.model-calibration-fields select:focus-visible { border-color: var(--accent); outline: 2px solid var(--accent); outline-offset: 2px; }
</style>
