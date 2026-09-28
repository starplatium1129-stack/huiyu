<script setup lang="ts">
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'

defineProps<{
  characterId: string
  active: 'profile' | 'scenes'
  scenePath?: '/popular-scenes' | '/scene-explorer'
}>()
</script>

<template>
  <nav class="character-context-nav" aria-label="角色内容导航">
    <RouterLink :to="{ path: '/character', query: { character: characterId } }" :aria-current="active === 'profile' ? 'page' : undefined">
      <ArchiveIcon name="character" />角色档案
    </RouterLink>
    <RouterLink :to="{ path: scenePath || '/popular-scenes', query: { character: characterId } }" :aria-current="active === 'scenes' ? 'page' : undefined">
      <ArchiveIcon name="scene" />角色场景
    </RouterLink>
  </nav>
</template>

<style scoped>
@reference "../../assets/css/tailwind.css";
.character-context-nav { @apply tw:inline-flex tw:flex-wrap tw:gap-s-1 tw:p-s-1 tw:rounded-lg; border:1px solid var(--border-soft); background:var(--bg-surface); }
.character-context-nav a { @apply tw:inline-flex tw:items-center tw:gap-s-2 tw:min-h-[40px] tw:rounded-md tw:text-secondary tw:text-label; padding:var(--s-2) var(--s-3); text-decoration:none; }
.character-context-nav a[aria-current='page'] { background:var(--accent-soft); @apply tw:text-accent tw:font-semibold; }
.character-context-nav a:hover { background:var(--bg-hover); }
.character-context-nav a:focus-visible { outline:2px solid var(--accent); outline-offset:-2px; }
</style>
