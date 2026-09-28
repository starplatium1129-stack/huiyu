<template><nav class="creative-library-nav" aria-label="创作资料导航"><RouterLink v-for="item in items" :key="item.path" :to="item.path" :aria-current="route.path === item.path ? 'page' : undefined">{{ item.label }}</RouterLink></nav></template>
<script setup lang="ts">
import { useRoute } from 'vue-router'
const route = useRoute()
const items = [{ path: '/style', label: '画风与氛围' }, { path: '/color-script', label: '色彩情绪' }, { path: '/lora', label: '模型资料' }, { path: '/scenario', label: '剧本与分幕' }]
</script>
<style scoped>
@reference "../../assets/css/tailwind.css";
.creative-library-nav { @apply tw:grid tw:gap-s-1 tw:p-s-1 tw:rounded-lg; width:min(800px,100%); grid-template-columns:repeat(4,minmax(0,1fr)); border:1px solid var(--border-soft); background:var(--bg-surface); }
.creative-library-nav a { @apply tw:flex tw:min-w-0 tw:min-h-[44px] tw:items-center tw:justify-center tw:rounded-md tw:text-secondary tw:text-body-sm tw:text-center; padding:var(--s-2) var(--s-3); }
.creative-library-nav a:hover { background:var(--bg-hover); @apply tw:text-primary; }
.creative-library-nav a[aria-current="page"] { background:var(--accent-soft); @apply tw:text-accent tw:font-semibold; }
.creative-library-nav a:focus-visible { outline:2px solid var(--accent); outline-offset:-2px; }
@media (max-width:600px) { .creative-library-nav { grid-template-columns:repeat(2,minmax(0,1fr)); } }
</style>
