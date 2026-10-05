<template>
  <span class="sensitive-preview-veil" aria-hidden="true">
    <!-- Share the already-resolved URL/CORS identity; no loader, Blob or retry ownership. -->
    <img v-if="src" class="sensitive-preview-image" :src="src" :crossorigin="crossorigin" alt="" loading="lazy" decoding="async" />
  </span>
</template>

<script setup lang="ts">
defineProps<{ src?: string; crossorigin?: '' | 'anonymous' | 'use-credentials' }>()
</script>

<style src="@/assets/css/sensitive-preview.css"></style>
