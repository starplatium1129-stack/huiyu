<!-- Lucian UX/UI Prompt #022 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#022 -->
<script setup lang="ts">
import { onDeactivated, ref, watch } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { useMotionPreference } from '@/composables/useMotionPreference'

const props = defineProps<{ active: boolean; label: string }>()
const reduced = useMotionPreference()
const burst = ref(false)
watch(() => props.active, (value, previous) => { burst.value = value && !previous && !reduced.value })
watch(reduced, value => { if (value) burst.value = false })
onDeactivated(() => { burst.value = false })
</script>

<template>
  <button class="u022" type="button" :aria-pressed="active" :aria-label="label" :data-active="active" :data-burst="burst" :data-reduced-motion="reduced">
    <span class="u022-heart" aria-hidden="true"><ArchiveIcon name="love" />
    <span v-if="burst" class="u022-burst" @animationend.self="burst = false">
      <span class="u022-ring" />
      <span v-for="n in 7" :key="n" class="u022-dot" :style="{ transform: `rotate(${(n - 1) * 360 / 7}deg)` }"><i /><i /></span>
    </span>
    </span>
    <slot />
  </button>
</template>

<style scoped>
.u022 { position:relative; isolation:isolate; }
.u022-heart { position:relative; display:inline-grid; place-items:center; flex:none; width:1.2em; height:1.2em; }
.u022-heart .archive-icon { width:100%; height:100%; }
.u022[data-active='true'] .u022-heart :deep(path) { fill:var(--accent-soft); }
.u022[data-burst='true'] .u022-heart { animation:u022-beat .7s cubic-bezier(.2,.8,.2,1); }
.u022-burst { position:absolute; left:50%; top:50%; width:0; height:0; pointer-events:none; animation:u022-life .9s linear; }
.u022-ring { position:absolute; left:-20px; top:-20px; width:40px; height:40px; border:2px solid var(--accent); border-radius:50%; opacity:0; animation:u022-ring .6s cubic-bezier(.2,.8,.2,1) .1s; }
.u022-dot { position:absolute; inset:0; }
.u022-dot i { position:absolute; left:-2px; top:-2px; width:4px; height:4px; border-radius:50%; background:var(--accent); opacity:0; animation:u022-fly .7s cubic-bezier(.2,.8,.2,1) .18s; }
.u022-dot i + i { width:3px; height:3px; background:var(--accent-violet); animation-name:u022-fly2; }
.u022:focus-visible { outline:none; box-shadow:var(--focus-shadow); }
@keyframes u022-life { from,to { opacity:1; } }
@keyframes u022-beat { 0%,100% { transform:scale(1); } 18% { transform:scale(.72); } 48% { transform:scale(1.24); } 70% { transform:scale(.94); } }
@keyframes u022-ring { from { transform:scale(.3); opacity:1; } to { transform:scale(1.4); opacity:0; } }
@keyframes u022-fly { from { opacity:1; transform:translate(0,-16px) scale(1); } to { opacity:0; transform:translate(0,-34px) scale(.2); } }
@keyframes u022-fly2 { from { opacity:1; transform:translate(3px,-14px) scale(1); } to { opacity:0; transform:translate(6px,-30px) scale(.2); } }
.u022[data-reduced-motion='true'] * { animation:none !important; transition:none !important; }
</style>
