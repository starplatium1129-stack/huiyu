<script setup lang="ts">
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import CreationDestinations from './CreationDestinations.vue'
</script>

<template>
  <section class="creation-guide container" aria-labelledby="creation-guide-title">
    <header class="guide-heading">
      <h2 id="creation-guide-title">从灵感到作品</h2>
      <RouterLink to="/guide" class="guide-direct">使用指南 <ArchiveIcon name="book" /></RouterLink>
    </header>
    <CreationDestinations />
  </section>
</template>

<style scoped>
.creation-guide { margin-block: var(--s-6); }
.guide-heading { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--s-2); margin-bottom: var(--s-3); }
.guide-heading h2 { margin: 0; font: 500 var(--fs-title-sm)/var(--lh-label) var(--font-serif); }
.guide-direct { display: inline-flex; align-items: center; gap: var(--s-2); min-height: 44px; color: var(--accent); font-size: var(--fs-label); }
</style>
