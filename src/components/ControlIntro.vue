<template>
  <header id="control-section-intro" class="control-intro">
    <div>
      <h1 id="control-section-heading" tabindex="-1">{{ title }}</h1>
      <p v-if="description" class="control-description">{{ description }}</p>
    </div>
    <div class="control-intro-actions"><slot name="actions" /></div>
  </header>
</template>
<script setup lang="ts">
defineProps<{ title: string; description?: string; group: string }>()
</script>
