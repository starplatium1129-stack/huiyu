<template>
  <header class="creative-library-header">
    <div class="creative-library-heading">
      <span class="creative-library-mark" aria-hidden="true"><ArchiveIcon name="book" /></span>
      <div><p class="creative-library-kicker">画室 / 创作手帖</p><h1>{{ title }}</h1><p v-if="description" class="creative-library-description">{{ description }}</p></div>
    </div>
    <CreativeLibraryNav />
  </header>
</template>

<script setup lang="ts">
import CreativeLibraryNav from './CreativeLibraryNav.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
defineProps<{ title: string; description?: string }>()
</script>

<style src="@/assets/css/creative-library.css"></style>
