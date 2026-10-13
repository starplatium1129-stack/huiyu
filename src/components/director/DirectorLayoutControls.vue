<template>
  <div class="director-layout-controls" role="group" aria-label="侧栏显示">
    <button id="director-materials-toggle" class="btn btn-ghost btn-sm" type="button" :aria-pressed="!collapsed.materials" :aria-expanded="!collapsed.materials" aria-controls="drawing-materials" @click="$emit('toggle', 'materials')"><ArchiveIcon name="manager" />素材</button>
    <button class="btn btn-ghost btn-sm" type="button" :aria-pressed="!collapsed.inspector" :aria-expanded="!collapsed.inspector" aria-controls="drawing-inspector" @click="$emit('toggle', 'inspector')"><ArchiveIcon name="gear" />参数</button>
  </div>
</template>
<script setup lang="ts">
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
defineProps<{ collapsed: { materials: boolean; inspector: boolean } }>()
defineEmits<{ toggle: [side: 'materials' | 'inspector'] }>()
</script>
<style scoped>
.director-layout-controls { display:none; gap:8px; }
button[aria-pressed=true] { color:var(--accent); border-color:var(--border-strong); }
@media (min-width:1024px) { .director-layout-controls { display:flex; } }
</style>
