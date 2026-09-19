<template>
  <div v-if="pb.historyRestoreReport" class="restore-notice" role="status">
    <details open>
      <summary>{{ pb.historyRestoreReport.title }}</summary>
      <ul><li v-for="note in pb.historyRestoreReport.notes" :key="note">{{ note }}</li></ul>
    </details>
    <button class="btn btn-ghost btn-icon" type="button" aria-label="关闭配方检查" @click="pb.historyRestoreReport = null"><ArchiveIcon name="close" /></button>
  </div>
</template>
<script setup lang="ts">
import { usePromptBuilderStore } from '@/stores/promptBuilderStore'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
const pb = usePromptBuilderStore()
</script>
<style scoped>
.restore-notice { display: flex; align-items: start; justify-content: space-between; gap: var(--s-3); padding: var(--s-3); margin-bottom: var(--s-3); border: 1px solid var(--border-soft); border-radius: var(--r-lg); background: var(--bg-surface); color: var(--text-primary); }
.restore-notice details { min-width: 0; overflow-wrap: anywhere; }
.restore-notice summary { cursor: pointer; font-size: var(--fs-label-sm); }
.restore-notice ul { color: var(--text-secondary); font-size: var(--fs-label-sm); line-height: var(--lh-body); margin-bottom: 0; padding-left: var(--s-4); }
</style>
