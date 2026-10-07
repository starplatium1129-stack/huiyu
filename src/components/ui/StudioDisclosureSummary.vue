<script setup lang="ts">
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
</script>

<template>
  <summary class="studio-disclosure-summary"><slot /><ArchiveIcon class="studio-disclosure-chevron" name="chevron-down" /></summary>
</template>

<style>
/* Keep native details state and each consumer's typography and spacing. */
:where(.studio-disclosure-summary) { display:flex; align-items:center; gap:var(--s-2); min-height:var(--control-height-sm); border-radius:var(--r-sm); overflow-wrap:anywhere; }
.studio-disclosure-summary > .studio-disclosure-chevron { width:16px; height:16px; flex-shrink:0; margin-inline-start:auto; color:var(--text-secondary); }
details[open] > .studio-disclosure-summary > .studio-disclosure-chevron { transform:rotate(180deg); }
.studio-disclosure-summary:hover:not(:focus-visible) { outline:1px solid var(--accent); outline-offset:-1px; }
@media (forced-colors:active) { .studio-disclosure-summary:hover:not(:focus-visible) { outline-color:Highlight; } }
</style>
