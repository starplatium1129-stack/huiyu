<script setup lang="ts">
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import AnimatedSelection from '@/components/visual/AnimatedSelection.vue'

defineProps<{
  characterId: string
  active: 'profile' | 'scenes'
  scenePath?: '/popular-scenes' | '/scene-explorer'
}>()
</script>

<template>
  <nav class="character-context-nav studio-segments" role="navigation" data-fluid-glass aria-label="角色内容导航">
    <AnimatedSelection target="[aria-current='page']" />
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
.character-context-nav { width:fit-content; flex-wrap:wrap; }
.character-context-nav a { position:relative; z-index:var(--z-raised); @apply tw:inline-flex tw:items-center tw:gap-s-2 tw:min-h-[40px] tw:rounded-md tw:text-secondary tw:text-label; padding:var(--s-2) var(--s-3); text-decoration:none; }
.character-context-nav a[aria-current='page'] { background:transparent; @apply tw:text-accent tw:font-semibold; }
.character-context-nav a:hover { background:var(--bg-hover); }
.character-context-nav a:focus-visible { outline:2px solid var(--accent); outline-offset:-2px; }
</style>
