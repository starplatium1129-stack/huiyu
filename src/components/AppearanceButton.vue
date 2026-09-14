<template><button type="button" class="appearance-button" aria-label="外观与动态效果" title="外观与动态效果" @click="open"><ArchiveIcon name="palette" /></button></template>
<script setup lang="ts">
import ArchiveIcon from './visual/ArchiveIcon.vue'
function open() { window.dispatchEvent(new CustomEvent('atelier:appearance-open', { detail: { section: 'appearance' } })) }
</script>
<style scoped>
.appearance-button { display: inline-grid; place-items: center; width: 38px; height: 38px; border: 1px solid var(--border-soft); border-radius: var(--r-md); color: var(--text-secondary); background: var(--bg-surface); cursor: pointer; }
.appearance-button:hover { color: var(--accent); background: var(--accent-soft); }
.appearance-button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>
