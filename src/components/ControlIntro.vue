<template>
  <header id="control-section-intro" class="control-intro">
    <div>
      <p class="control-eyebrow">控制面板 <span aria-hidden="true">/</span> {{ group }}</p>
      <h1 id="control-section-heading" tabindex="-1">{{ title }}</h1>
      <p class="control-description">{{ description }}</p>
    </div>
    <div class="control-intro-actions"><slot name="actions" /></div>
  </header>
</template>
<script setup lang="ts">
defineProps<{ title: string; description: string; group: string }>()
</script>
