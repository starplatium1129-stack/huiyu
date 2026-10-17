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
html body .creative-library-nav.studio-segments[role] { display:grid; width:min(800px,100%); grid-template-columns:repeat(4,minmax(0,1fr)); }
.creative-library-nav a { min-width:0; text-align:center; }
.creative-library-nav a::after { content:''; position:absolute; inset:auto 24% 0; height:2px; border-radius:var(--r-pill); background:var(--accent); opacity:0; transition:opacity var(--motion-control) var(--ease-out); }
.creative-library-nav a[aria-current='page']::after { opacity:1; }
.creative-library-nav .archive-icon { width:18px; height:18px; flex-shrink:0; }
@media (max-width:600px) { html body .creative-library-nav.studio-segments[role] { grid-template-columns:repeat(2,minmax(0,1fr)); } }
</style>
