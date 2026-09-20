<script setup lang="ts">
import { ToggleGroupItem, ToggleGroupRoot, type AcceptableValue } from 'reka-ui'

defineProps<{ modelValue: 'basic' | 'pro' }>()
const emit = defineEmits<{ 'update:modelValue': [value: 'basic' | 'pro'] }>()
function select(value: AcceptableValue | AcceptableValue[]) {
  // A workspace must always have a mode, including when its active item is pressed again.
  if (value === 'basic' || value === 'pro') emit('update:modelValue', value)
}
</script>

<template>
  <ToggleGroupRoot type="single" :model-value="modelValue" orientation="horizontal"
    class="director-mode-switch" aria-label="切换绘图工作模式" @update:model-value="select">
    <ToggleGroupItem value="basic" class="director-mode-option" :class="{ active: modelValue === 'basic' }">场景模式</ToggleGroupItem>
    <ToggleGroupItem value="pro" class="director-mode-option" :class="{ active: modelValue === 'pro' }">专家模式</ToggleGroupItem>
  </ToggleGroupRoot>
</template>
