<template><nav class="creative-library-nav tw:flex tw:flex-wrap tw:gap-s-2 tw:pb-s-5 tw:mb-s-5" aria-label="创作资料导航"><RouterLink v-for="item in items" :key="item.path" :to="item.path" class="tw:min-h-[40px] tw:inline-flex tw:items-center tw:rounded-md tw:text-secondary tw:text-body-sm" :aria-current="route.path === item.path ? 'page' : undefined">{{ item.label }}</RouterLink></nav></template>
<script setup lang="ts">
import { useRoute } from 'vue-router'
const route = useRoute()
const items = [{ path: '/style', label: '画风与氛围' }, { path: '/color-script', label: '色彩情绪' }, { path: '/lora', label: '模型资料' }, { path: '/scenario', label: '剧本与分幕' }]
</script>
<style scoped>
@reference "../../assets/css/tailwind.css";
.creative-library-nav { border-bottom: 1px solid var(--border-soft); }
.creative-library-nav a { padding: var(--s-2) var(--s-4); }
.creative-library-nav a[aria-current="page"] { background: var(--accent-soft); @apply tw:text-accent; }
</style>
