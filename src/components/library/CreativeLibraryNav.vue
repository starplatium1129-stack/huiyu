<template>
  <nav class="creative-library-nav studio-segments" role="navigation" data-fluid-glass aria-label="创作资料导航">
    <AnimatedSelection target="[aria-current='page']" />
    <RouterLink v-for="item in items" :key="item.path" :to="item.path" :aria-current="route.path === item.path ? 'page' : undefined">
      <ArchiveIcon :name="item.icon" /><span>{{ item.label }}</span>
    </RouterLink>
  </nav>
</template>
<script setup lang="ts">
import { useRoute } from 'vue-router'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import AnimatedSelection from '@/components/visual/AnimatedSelection.vue'
const route = useRoute()
const items = [
  { path: '/style', label: '画风与氛围', icon: 'image' },
  { path: '/color-script', label: '色彩情绪', icon: 'palette' },
  { path: '/lora', label: '模型资料', icon: 'model' },
  { path: '/scenario', label: '剧本与分幕', icon: 'book' },
] as const
</script>
<style scoped>
@reference "../../assets/css/tailwind.css";
html body .creative-library-nav.studio-segments[role] { display:grid; width:min(800px,100%); grid-template-columns:repeat(4,minmax(0,1fr)); }
.creative-library-nav a { position:relative; z-index:var(--z-raised); @apply tw:flex tw:min-w-0 tw:min-h-[44px] tw:items-center tw:justify-center tw:gap-s-2 tw:rounded-md tw:text-secondary tw:text-body-sm tw:text-center; padding:var(--s-2) var(--s-3); }
.creative-library-nav .archive-icon { width:18px; height:18px; flex-shrink:0; }
.creative-library-nav a:hover { background:var(--bg-hover); @apply tw:text-primary; }
.creative-library-nav a[aria-current="page"] { background:transparent; @apply tw:text-accent tw:font-semibold; }
.creative-library-nav a:focus-visible { outline:2px solid var(--accent); outline-offset:-2px; }
@media (max-width:600px) { html body .creative-library-nav.studio-segments[role] { grid-template-columns:repeat(2,minmax(0,1fr)); } }
</style>
