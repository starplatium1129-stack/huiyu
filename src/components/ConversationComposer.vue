<template>
  <div class="conversation-compose" :data-density="density">
    <div class="conversation-compose-dock" :data-tools="hasTools || undefined">
      <div class="conversation-compose-editor"><slot /></div>
      <div v-if="hasTools" class="conversation-compose-tools">
        <slot name="tools" />
      </div>
      <div class="conversation-compose-commit"><slot name="commit" /></div>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{ density: 'compact' | 'room'; hasTools: boolean }>()
</script>

<style scoped>
.conversation-compose {
  container: chat-composer / inline-size;
  min-inline-size:0;
  flex-shrink:0;
}
.conversation-compose-dock {
  position:relative;
  isolation:isolate;
  display:grid;
  grid-template-columns:minmax(0,1fr) auto;
  grid-template-areas:"editor commit";
  gap:var(--s-1) var(--s-2);
  align-items:end;
  min-inline-size:0;
  padding:var(--s-1) var(--s-2);
  border:1px solid var(--border-soft);
  border-radius:var(--r-lg);
  background:var(--conversation-compose-fill,var(--bg-surface));
}
.conversation-compose-dock[data-tools] { grid-template-areas:"editor commit" "tools tools"; }
.conversation-compose-dock:focus-within { border-color:var(--border-strong); box-shadow:var(--focus-shadow); }
.conversation-compose-editor { grid-area:editor; min-inline-size:0; }
.conversation-compose-tools { grid-area:tools; display:flex; flex-wrap:wrap; align-items:center; gap:var(--s-1); min-inline-size:0; }
.conversation-compose-commit { grid-area:commit; display:flex; align-items:center; }
.conversation-compose[data-density='compact'] .conversation-compose-dock { border-radius:var(--r-md); }
@container chat-composer (min-width:400px) {
  .conversation-compose-dock[data-tools] {
    grid-template-columns:auto minmax(0,1fr) auto;
    grid-template-areas:"tools editor commit";
  }
}
@media (forced-colors:active) {
  .conversation-compose-dock:focus-within { outline:2px solid Highlight; outline-offset:2px; }
}
</style>
