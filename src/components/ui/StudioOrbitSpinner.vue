<!-- Lucian UX/UI Prompt #080 · MIT (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#080 -->
<script setup lang="ts">
import { useMotionPreference } from '@/composables/useMotionPreference'
const reduced = useMotionPreference()
</script>
<template>
  <span class="studio-orbit-spinner" :data-reduced-motion="reduced" aria-hidden="true">
    <span class="orbit-track"><i /></span><span class="orbit-track orbit-track-inner"><i /></span><span class="orbit-core" />
  </span>
</template>
<style scoped>
.studio-orbit-spinner { display:inline-block; position:relative; flex-shrink:0; width:40px; height:40px; color:var(--accent); }
.orbit-track { position:absolute; inset:3px; border:1px solid var(--border-strong); border-radius:50%; transform:rotate(-30deg) scaleY(.6); }
.orbit-track-inner { inset:8px; transform:rotate(55deg) scaleY(.65); }
.orbit-track i { position:absolute; inset:0; animation:orbit-turn 1.8s linear infinite; }
.orbit-track-inner i { animation-direction:reverse; animation-duration:1.4s; }
.orbit-track i::before { content:''; position:absolute; top:-2px; left:calc(50% - 2px); width:4px; height:4px; border-radius:50%; background:currentColor; }
.orbit-core { position:absolute; left:calc(50% - 3px); top:calc(50% - 3px); width:6px; height:6px; border-radius:50%; background:var(--accent); }
@keyframes orbit-turn { to { transform:rotate(360deg); } }
.studio-orbit-spinner[data-reduced-motion='true'] i { animation:none; }
@media (forced-colors:active) { .orbit-track { border-color:CanvasText; } .orbit-core { background:CanvasText; } }
</style>
