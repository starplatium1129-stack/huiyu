<template>
  <header class="creative-library-header">
    <div class="creative-library-heading">
      <p class="creative-library-kicker">HUIYU / CREATIVE LIBRARY</p>
      <h1>{{ title }}</h1>
      <p class="creative-library-description">{{ description }}</p>
    </div>
    <CreativeLibraryNav />
  </header>
</template>

<script setup lang="ts">
import CreativeLibraryNav from './CreativeLibraryNav.vue'
defineProps<{ title: string; description: string }>()
</script>

<style src="@/assets/css/creative-library.css"></style>
