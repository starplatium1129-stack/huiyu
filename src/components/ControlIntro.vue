<template>
  <header class="control-intro tw:flex tw:items-center tw:justify-between tw:gap-s-5 tw:mb-s-6">
    <div>
      <p class="control-eyebrow tw:m-0 tw:mb-s-3 tw:text-accent tw:text-label tw:tracking-[.08em]">绘遇 / 本机控制室</p>
      <h1 class="control-title tw:m-0 tw:text-primary tw:tracking-[-.02em]">把画室，准备好。</h1>
      <p class="control-subtitle tw:m-0 tw:mt-s-3 tw:text-secondary tw:text-body-sm tw:leading-loose">管理创作服务、安排显存，让每一次心动顺利成画。</p>
    </div>
    <div class="control-intro-actions tw:flex tw:flex-col tw:items-end tw:gap-s-3 tw:shrink-0"><span class="control-count tw:text-muted tw:text-label" role="status">{{ readyLabel }}</span><div class="control-intro-buttons tw:flex tw:gap-s-2 tw:flex-wrap"><slot name="actions" /></div></div>
  </header>
</template>
<script setup lang="ts">
defineProps<{ readyLabel: string }>()
</script>
<style scoped>
@reference "../assets/css/tailwind.css";
.control-title { font: 500 var(--fs-display)/var(--lh-tight) var(--font-serif); }
@media (max-width: 1200px) { .control-intro { @apply tw:items-start tw:flex-col; } .control-intro-actions { @apply tw:items-start; } }
</style>
