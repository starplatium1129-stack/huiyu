<script setup lang="ts">
import { ref } from 'vue'
import ArchiveIcon, { type ArchiveIconName } from '@/components/visual/ArchiveIcon.vue'
import { useToggleMotion } from '@/composables/useToggleMotion'

const props = withDefaults(defineProps<{ active: boolean; name?: ArchiveIconName; angle?: number }>(), { name: 'chevron-down', angle: 180 })
const icon = ref<{ $el: SVGElement } | null>(null)
useToggleMotion(() => props.active, progress => {
  for (const path of icon.value?.$el.children ?? []) {
    if (path instanceof SVGElement) path.style.transform = `rotate(${props.angle * progress}deg)`
  }
})
</script>

<template>
  <ArchiveIcon ref="icon" :name="name" class="studio-toggle-icon" :data-active="active" :style="{ '--toggle-icon-angle': `${angle}deg` }" />
</template>

<style scoped>
/* Rotate the drawing inside a stationary SVG viewport, including while pressed. */
.studio-toggle-icon :deep(path) { transform-box:view-box; transform-origin:center; }
.studio-toggle-icon[data-active='true'] :deep(path) { transform:rotate(var(--toggle-icon-angle)); }
</style>
