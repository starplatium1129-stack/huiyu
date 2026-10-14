<template>
  <header class="creative-library-header">
    <div class="creative-library-heading">
      <h1>{{ title }}</h1>
    </div>
    <CreativeLibraryNav />
  </header>
</template>

<script setup lang="ts">
import CreativeLibraryNav from './CreativeLibraryNav.vue'
defineProps<{ title: string }>()
</script>

<style src="@/assets/css/creative-library.css"></style>
