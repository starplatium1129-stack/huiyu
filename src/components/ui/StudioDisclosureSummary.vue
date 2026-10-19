<script setup lang="ts">
import { onActivated, onDeactivated, onMounted, onScopeDispose, ref } from 'vue'
import StudioToggleIcon from './StudioToggleIcon.vue'

const summary = ref<HTMLElement | null>(null)
const expanded = ref(false)
let details: HTMLDetailsElement | undefined
const syncOpen = () => { expanded.value = details?.open ?? false }
function start() {
  const parent = summary.value?.parentElement
  if (details || !(parent instanceof HTMLDetailsElement)) return
  details = parent
  syncOpen()
  details.addEventListener('toggle', syncOpen)
}
function stop() { details?.removeEventListener('toggle', syncOpen); details = undefined }
onMounted(start)
onActivated(start)
onDeactivated(stop)
onScopeDispose(stop)
</script>

<template>
  <summary ref="summary" class="studio-disclosure-summary" data-spring-button><slot /><StudioToggleIcon :active="expanded" class="studio-disclosure-chevron" /></summary>
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
</style>
