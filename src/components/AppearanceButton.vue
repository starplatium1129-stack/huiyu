<template>
  <StudioTooltip content="外观与动态效果">
    <button type="button" class="appearance-button tw:inline-grid tw:place-items-center tw:w-[38px] tw:h-[38px] tw:rounded-md tw:text-secondary tw:cursor-pointer" aria-label="外观与动态效果" @click="open">
      <ArchiveIcon name="palette" />
    </button>
  </StudioTooltip>
</template>
<script setup lang="ts">
import ArchiveIcon from './visual/ArchiveIcon.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
function open() { window.dispatchEvent(new CustomEvent('atelier:appearance-open', { detail: { section: 'appearance' } })) }
</script>
<style scoped>
@reference "../assets/css/tailwind.css";
.appearance-button { border: 1px solid var(--border-soft); background: var(--bg-surface); }
.appearance-button:hover { @apply tw:text-accent; background: var(--accent-soft); }
.appearance-button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>
