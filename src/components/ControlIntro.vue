<template>
  <header class="control-intro tw:flex tw:items-center tw:justify-between tw:gap-s-5 tw:mb-s-5">
    <div class="control-intro-copy">
      <img class="control-intro-art" :src="modelArt" width="512" height="512" alt="" />
      <div>
        <p class="control-eyebrow tw:m-0 tw:mb-s-2 tw:text-accent tw:text-label-sm tw:tracking-[.08em]">绘遇 / 本机控制室</p>
        <h1 class="control-title tw:m-0 tw:text-primary tw:tracking-[-.02em]">设置与资源</h1>
      </div>
    </div>
    <div class="control-intro-actions tw:flex tw:flex-col tw:items-end tw:gap-s-3 tw:shrink-0"><span class="control-count tw:text-muted tw:text-label" role="status">{{ readyLabel }}</span><div class="control-intro-buttons tw:flex tw:gap-s-2 tw:flex-wrap"><slot name="actions" /></div></div>
  </header>
</template>
<script setup lang="ts">
import modelOriginal from '@/assets/illustrations/atelier-model-spot.webp'
import { useThemeIllustration } from '@/composables/useThemeIllustration'
defineProps<{ readyLabel: string }>()
const modelArt = useThemeIllustration(modelOriginal, 'model')
</script>
<style scoped>
@reference "../assets/css/tailwind.css";
.control-title { font:600 var(--fs-title)/var(--lh-tight) var(--font-display); }
.control-intro-copy { display:flex; align-items:center; gap:var(--s-4); min-width:0; }
.control-intro-art { display:block; flex:none; width:88px; height:88px; object-fit:contain; pointer-events:none; }
.control-count { padding:var(--s-1) var(--s-3); border-radius:var(--r-pill); background:var(--bg-surface); @apply tw:text-secondary tw:text-label-sm; }
@media (max-width: 900px) { .control-intro { @apply tw:items-start tw:flex-col; } .control-intro-art { width:64px; height:64px; } .control-intro-actions { @apply tw:items-start; } }
</style>
