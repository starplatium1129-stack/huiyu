<template>
  <span class="chat-turn-indicator" role="status">
    <span v-if="animated" class="chat-turn-dots" aria-hidden="true"><i /><i /><i /></span>
    <span>{{ label }}</span>
  </span>
</template>

<script setup lang="ts">
defineProps<{ label: string; animated?: boolean }>()
</script>

<style scoped>
.chat-turn-indicator { display:inline-flex; align-items:center; gap:var(--s-2); min-inline-size:0; color:var(--text-secondary); overflow-wrap:anywhere; }
.chat-turn-dots { display:inline-flex; gap:var(--s-1); padding-inline:var(--s-1); }
.chat-turn-dots i { inline-size:4px; block-size:4px; border-radius:var(--r-pill); background:currentColor; animation:chat-turn-breathe 1.4s var(--ease-out) infinite; }
.chat-turn-dots i:nth-child(2) { animation-delay:120ms; }
.chat-turn-dots i:nth-child(3) { animation-delay:240ms; }
@keyframes chat-turn-breathe {
  0%,60%,100% { opacity:.52; transform:translateY(0); }
  30% { opacity:1; transform:translateY(-2px); }
}
.chat-turn-indicator { transition:opacity var(--motion-control) var(--ease-out), transform var(--motion-control) var(--ease-out); }
@starting-style {
  .chat-turn-indicator { opacity:0; transform:translateY(3px); }
}
:global(:root:is([data-motion='reduce'],[data-motion='reduced'])) .chat-turn-indicator { transition:none; }
:global(:root:is([data-motion='reduce'],[data-motion='reduced'])) .chat-turn-dots i { animation:none; }
@media (prefers-reduced-motion:reduce) {
  :global(:root:not([data-motion='full'])) .chat-turn-indicator { transition:none; }
  :global(:root:not([data-motion='full'])) .chat-turn-dots i { animation:none; }
}
</style>
