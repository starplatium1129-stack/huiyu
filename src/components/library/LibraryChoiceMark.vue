<script setup lang="ts">
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
defineProps<{ selected: boolean }>()
</script>

<template>
  <span class="library-choice-mark" :data-selected="selected" aria-hidden="true">
    <ArchiveIcon name="chevron-down" class="choice-arrow" />
    <ArchiveIcon name="success" class="choice-check" />
  </span>
</template>

<style scoped>
.library-choice-mark {
  display:grid;
  place-items:center;
  flex:none;
  width:22px;
  height:22px;
  border:1px solid var(--border-soft);
  border-radius:50%;
  color:var(--text-secondary);
}
.library-choice-mark .archive-icon {
  grid-area:1/1;
  width:14px;
  height:14px;
  transition:transform var(--motion-control) var(--spring-soft), opacity var(--motion-hover) var(--ease-out);
}
.choice-arrow { transform:rotate(-90deg); }
.choice-check { opacity:0; transform:scale(.75); }
[data-selected='true'] { color:var(--text-primary); border-color:var(--border-strong); background:var(--bg-surface); }
[data-selected='true'] .choice-arrow { opacity:0; transform:translateX(3px) rotate(-90deg); }
[data-selected='true'] .choice-check { opacity:1; transform:none; }
@media (prefers-reduced-motion:reduce) { :root:not([data-motion='full']) .library-choice-mark .archive-icon { transition:none; } }
:root:is([data-motion='reduce'],[data-motion='reduced']) .library-choice-mark .archive-icon { transition:none; }
@media (forced-colors:active) { [data-selected='true'] { border-color:Highlight; color:Highlight; } }
</style>
