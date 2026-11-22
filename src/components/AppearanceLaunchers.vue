<template>
  <button class="appearance-entry" type="button" @click="launch('appearance')"><ArchiveIcon name="palette" />外观与动态效果</button>
  <button class="appearance-entry" type="button" @click="launch('keyboard')"><ArchiveIcon name="gear" />键盘快捷键 <kbd>F1</kbd></button>
</template>

<script setup lang="ts">
import ArchiveIcon from './visual/ArchiveIcon.vue'

const emit = defineEmits<{ open: [] }>()
function launch(section: 'appearance' | 'keyboard') {
  window.dispatchEvent(new CustomEvent('atelier:appearance-open', { detail: { section } }))
  emit('open')
}
</script>

<style>
@reference "../assets/css/tailwind.css";
.appearance-entry { @apply tw:flex tw:items-center tw:gap-s-2; grid-column: 1 / -1; @apply tw:p-s-3; border: 0; @apply tw:rounded-md; background: transparent; @apply tw:text-secondary; font: inherit; @apply tw:text-left tw:cursor-pointer; }
.appearance-entry:hover { background: transparent; @apply tw:text-primary; }
.appearance-entry:focus-visible { outline:none; box-shadow:var(--focus-shadow); }
.appearance-entry kbd { margin-inline-start: auto; }
</style>
