<template>
  <div class="director-layout-controls">
    <StudioPopover v-model:open="open" label="工作台布局" content-class="director-layout-menu">
      <template #trigger><button class="btn btn-ghost btn-sm" type="button" aria-label="工作台布局"><ArchiveIcon name="gear" />布局</button></template>
      <p class="director-layout-hint">保留画布空间，按需展开两侧栏。拖动栏间分隔线可调整宽度。</p>
      <div class="director-layout-choices" role="group" aria-label="侧栏显示">
        <button class="btn btn-ghost btn-sm" type="button" :aria-pressed="!collapsed.materials" :aria-expanded="!collapsed.materials" aria-controls="drawing-materials" @click="emit('toggle', 'materials')"><ArchiveIcon name="scene" />{{ collapsed.materials ? '展开素材' : '收起素材' }}</button>
        <button class="btn btn-ghost btn-sm" type="button" :aria-pressed="!collapsed.inspector" :aria-expanded="!collapsed.inspector" aria-controls="drawing-inspector" @click="emit('toggle', 'inspector')"><ArchiveIcon name="gear" />{{ collapsed.inspector ? '展开参数' : '收起参数' }}</button>
        <button class="btn btn-ghost btn-sm" type="button" aria-label="恢复默认布局" @click="emit('reset')"><ArchiveIcon name="refresh" />恢复默认布局</button>
      </div>
    </StudioPopover>
  </div>
</template>
<script setup lang="ts">
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioPopover from '@/components/ui/StudioPopover.vue'
defineProps<{ collapsed: { materials: boolean; inspector: boolean } }>()
const emit = defineEmits<{ toggle: [side: 'materials' | 'inspector']; reset: [] }>()
const open = defineModel<boolean>('open', { default: false })
</script>
<style scoped>
.director-layout-controls { display: none; }
@media (min-width: 1024px) {
  .director-layout-controls { display: block; }
}
</style>
<style>
.director-layout-hint { margin:0 0 var(--s-3); color:var(--text-secondary); font-size:var(--fs-label); line-height:var(--lh-body); }
.director-layout-choices { display:grid; gap:var(--s-2); }
.director-layout-choices button { justify-content:flex-start; }
</style>
