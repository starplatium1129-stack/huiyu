<script setup lang="ts">
import AnimatedSelection from '@/components/visual/AnimatedSelection.vue'
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
    class="studio-segments studio-segments--compact" data-fluid-glass data-segment-keyboard="managed" aria-label="切换绘图工作模式" @update:model-value="select">
    <AnimatedSelection />
    <ToggleGroupItem value="basic"><span class="studio-control-label">场景模式</span></ToggleGroupItem>
    <ToggleGroupItem value="pro"><span class="studio-control-label">专家模式</span></ToggleGroupItem>
  </ToggleGroupRoot>
</template>
