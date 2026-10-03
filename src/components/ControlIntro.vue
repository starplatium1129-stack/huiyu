<template>
  <header class="control-intro tw:flex tw:items-center tw:justify-between tw:gap-s-5 tw:mb-s-5">
    <div>
      <p class="control-eyebrow tw:m-0 tw:mb-s-2 tw:text-accent tw:text-label-sm tw:tracking-[.08em]">绘遇 / 本机控制室</p>
      <h1 class="control-title tw:m-0 tw:text-primary tw:tracking-[-.02em]">设置与资源</h1>
      <p class="control-subtitle tw:m-0 tw:mt-s-2 tw:text-secondary tw:text-body-sm tw:leading-body">检查服务，管理离线资源与运行偏好。</p>
    </div>
    <div class="control-intro-actions tw:flex tw:flex-col tw:items-end tw:gap-s-3 tw:shrink-0"><span class="control-count tw:text-muted tw:text-label" role="status">{{ readyLabel }}</span><div class="control-intro-buttons tw:flex tw:gap-s-2 tw:flex-wrap"><slot name="actions" /></div></div>
  </header>
</template>
<script setup lang="ts">
defineProps<{ readyLabel: string }>()
</script>
<style scoped>
@reference "../assets/css/tailwind.css";
.control-title { font:600 var(--fs-title)/var(--lh-tight) var(--font-display); }
.control-count { padding:var(--s-1) var(--s-3); border-radius:var(--r-pill); background:var(--bg-surface); @apply tw:text-secondary tw:text-label-sm; }
@media (max-width: 900px) { .control-intro { @apply tw:items-start tw:flex-col; } .control-intro-actions { @apply tw:items-start; } }
</style>
