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
.character-context-nav { width:fit-content; flex-wrap:wrap; }
</style>
