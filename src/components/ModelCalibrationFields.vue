<template>
  <fieldset class="model-calibration-fields" :disabled="disabled || !parameters.length">
    <legend>{{ title }}</legend>
    <label>{{ title }}参数
      <StudioSelect :model-value="binding.id" :disabled="!parameters.length" :label="`${title}参数`"
        :options="[{ value: '', label: '不覆写，保留作者动画' }, ...parameters.map(parameter => ({ value: parameter.id, label: parameter.id }))]"
        @update:model-value="(value) => $emit('update', { ...binding, id: String(value) }, true)" />
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
import StudioSelect from '@/components/ui/StudioSelect.vue'
const props = defineProps<{ title: string; binding: CalibrationBinding; parameters: ModelParameter[]; disabled?: boolean }>()
defineEmits<{ update: [value: CalibrationBinding, select: boolean] }>()
const range = computed(() => props.parameters.find(item => item.id === props.binding.id))
</script>

<style scoped>
/* 原生 <select> 已迁移为 StudioSelect：外观由组件统一提供；布局（宽度/最小高度）落在 wrapper。 */
.model-calibration-fields .studio-select-wrapper { width: 100%; min-height: 40px; }
</style>
