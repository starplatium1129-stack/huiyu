<script setup lang="ts">
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
</script>

<template>
  <summary class="studio-disclosure-summary" data-spring-button><slot /><ArchiveIcon class="studio-disclosure-chevron" name="chevron-down" /></summary>
</template>

<style>
/* Keep native details state and each consumer's typography and spacing. */
:where(.studio-disclosure-summary) { display:flex; align-items:center; gap:var(--s-2); min-height:var(--control-height-sm); border-radius:var(--r-sm); overflow-wrap:anywhere; }
/* Lucian #044 · MIT (c) 2026 Seokwoooo. Native details and the shared content
   reveal retain focus and state; only the disclosure glyph changes pose. */
.studio-disclosure-summary > .studio-disclosure-chevron { width:16px; height:16px; flex-shrink:0; margin-inline-start:auto; color:inherit; }
@media (hover:hover) and (pointer:fine) {
  .studio-disclosure-summary:hover:not(:focus-visible) { color:var(--text-primary); }
}
/* Rotate the drawing inside its fixed viewport without widening native scroll areas. */
.studio-disclosure-chevron > path { transform-box:view-box; transform-origin:center; transition:transform var(--spring-gentle-duration) var(--spring-gentle-ease); }
details[open] > .studio-disclosure-summary > .studio-disclosure-chevron > path { transform:rotate(180deg); }
.studio-disclosure-summary:focus-visible > .studio-disclosure-chevron,.studio-disclosure-summary:focus-visible > .studio-disclosure-chevron > path { transition:none; }
@media (prefers-reduced-motion:reduce) {
  :root:not([data-motion='full']) .studio-disclosure-chevron > path { transition:none; }
}
:root:is([data-motion='reduce'],[data-motion='reduced'],[data-reduced-motion='true']) .studio-disclosure-chevron > path { transition:none; }
</style>
