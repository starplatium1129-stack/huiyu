<template><button class="task-center-button tw:inline-flex tw:items-center tw:justify-center tw:gap-s-2 tw:rounded-md tw:text-primary tw:cursor-pointer" data-spring-button type="button" aria-haspopup="dialog" @click="opened = true"><span class="task-center-content" data-press-content><ArchiveIcon name="queue" /><span>任务</span><strong v-if="activeCount">{{ activeCount }}</strong></span></button></template>
<script setup lang="ts">
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { useTaskCenter } from '@/composables/useTaskCenter'
const { opened, activeCount } = useTaskCenter()
</script>
<style scoped>
@reference "../../assets/css/tailwind.css";
.task-center-button { min-height:var(--control-height); padding:var(--s-2) var(--s-3); border:1px solid var(--border-soft); background:var(--bg-surface); font:600 var(--fs-label)/var(--lh-label) var(--font-sans); }
.task-center-content { display:inline-flex; align-items:center; gap:var(--s-2); }
.task-center-content > .archive-icon { width:16px; height:16px; }
.task-center-button strong { @apply tw:text-accent; font-variant-numeric: tabular-nums; }
@media (hover:hover) and (pointer:fine) {
  .task-center-button:hover { background:transparent; border-color:var(--border-strong); color:var(--text-primary); }
}
</style>
