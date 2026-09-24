<script setup lang="ts">
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from 'reka-ui'

withDefaults(defineProps<{ label: string; contentClass?: string; align?: 'start' | 'center' | 'end' }>(), { align:'end', contentClass:'' })
const open = defineModel<boolean>('open', { default:false })
const emit = defineEmits<{ closeAutoFocus: [event: Event] }>()
</script>

<template>
  <PopoverRoot v-model:open="open">
    <PopoverTrigger as-child><slot name="trigger" /></PopoverTrigger>
    <PopoverPortal>
      <PopoverContent :align="align" :side-offset="10" :collision-padding="16"
        hide-when-detached as-child @close-auto-focus="emit('closeAutoFocus', $event)">
        <div :aria-label="label" :aria-labelledby="undefined" class="studio-popover" :class="contentClass"><slot /></div>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>

<!-- Reka portals cross component roots; keep these uniquely prefixed rules global. -->
<style>
.studio-popover { z-index:var(--z-popover); width:min(340px,calc(100vw - 32px)); max-height:var(--reka-popover-content-available-height, calc(100dvh - 32px)); overflow-y:auto; overscroll-behavior:contain; padding:var(--s-4); border:1px solid var(--border-soft); border-radius:var(--r-xl); background:var(--bg-surface); color:var(--text-primary); box-shadow:var(--shadow-lg); transform-origin:var(--reka-popover-content-transform-origin, top right); }
.studio-popover[data-state='open'] { animation:studio-popover-in var(--motion-surface) var(--ease-out) both; }
.studio-popover[data-state='closed'] { animation:studio-popover-out var(--motion-hover) var(--ease-out) both; }
@keyframes studio-popover-in { from { opacity:0; transform:translateY(-4px) scale(.97); } to { opacity:1; transform:none; } }
@keyframes studio-popover-out { from { opacity:1; transform:none; } to { opacity:0; transform:translateY(-2px) scale(.985); } }
@media(prefers-reduced-motion:reduce) { .studio-popover[data-state] { animation:none; } }
@media(forced-colors:active) { .studio-popover { background:Canvas; border-color:CanvasText; } }
</style>
