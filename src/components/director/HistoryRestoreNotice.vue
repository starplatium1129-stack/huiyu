<template>
  <div v-if="pb.historyRestoreReport" class="restore-notice tw:flex tw:justify-between tw:gap-s-3 tw:p-s-3 tw:mb-s-3 tw:rounded-lg tw:text-primary" role="status">
    <details class="tw:min-w-0 tw:wrap-anywhere" open>
      <summary class="tw:cursor-pointer tw:text-label-sm">{{ pb.historyRestoreReport.title }}</summary>
      <ul class="tw:text-secondary tw:text-label-sm tw:leading-body tw:mb-0 tw:pl-s-4"><li v-for="note in pb.historyRestoreReport.notes" :key="note">{{ note }}</li></ul>
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
.restore-notice { align-items: start; border: 1px solid var(--border-soft); background: var(--bg-surface); }
</style>
