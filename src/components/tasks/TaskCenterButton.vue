<template><button class="task-center-button tw:inline-flex tw:items-center tw:justify-center tw:gap-s-2 tw:min-h-[38px] tw:rounded-md tw:text-primary tw:cursor-pointer" type="button" aria-haspopup="dialog" @click="opened = true"><ArchiveIcon name="queue" /><span>任务</span><strong v-if="activeCount">{{ activeCount }}</strong></button></template>
<script setup lang="ts">
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { useTaskCenter } from '@/composables/useTaskCenter'
const { opened, activeCount } = useTaskCenter()
</script>
<style scoped>
@reference "../../assets/css/tailwind.css";
.task-center-button { padding: var(--s-2) var(--s-3); border: 1px solid var(--border-soft); background: var(--bg-surface); font: 600 var(--fs-label) var(--font-sans); }
.task-center-button strong { @apply tw:text-accent; font-variant-numeric: tabular-nums; }
@media (hover:hover) and (pointer:fine) {
  .task-center-button:hover { background:var(--accent-soft); border-color:var(--accent); color:var(--accent); }
}
</style>
