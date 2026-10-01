<template>
  <div ref="root" class="generation-dust" :class="{ 'is-running': canAnimate && !lowEffects }" aria-hidden="true">
    <i v-for="grain in grains" :key="grain.id" :style="grain.style" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useVisualActivity } from '@/composables/useVisualActivity'
const props = withDefaults(defineProps<{ framed?: boolean }>(), { framed: false })
const root = ref<HTMLElement | null>(null)
const { canAnimate, lowEffects } = useVisualActivity(root)
// Fixed phase offsets keep Vue out of the frame loop and avoid layout-sized layers.
const grains = computed(() => Array.from({ length: 28 }, (_, id) => {
  const right = id % 2 === 1
  const band = Math.floor(id / 2)
  return { id, style: {
    left: props.framed ? (right ? 'calc(100% - 10px)' : '8px') : `${right ? 75 - band * 1.1 : 25 + band * 1.1}%`,
    top: `${props.framed ? 10 + band * 6 : 32 + (band % 7) * 6}%`,
    '--dust-x': `${(right ? -1 : 1) * (props.framed ? 5 : 22 + band % 5 * 4)}px`,
    '--dust-y': `${-5 - band % 4 * 3}px`,
    '--dust-delay': `${-id * 0.173}s`,
    '--dust-duration': `${3.2 + band % 4 * 0.23}s`,
  } }
}))
</script>

<style scoped>
.generation-dust { position:absolute; inset:0; overflow:hidden; pointer-events:none; z-index:2; }
.generation-dust i { position:absolute; width:2px; height:2px; border-radius:50%; background:var(--accent); opacity:.22; }
.generation-dust i:nth-child(3n) { background:var(--accent-violet); }
.generation-dust i:nth-child(5n) { width:3px; height:3px; }
.generation-dust.is-running i { animation:dust-converge var(--dust-duration) var(--dust-delay) ease-in-out infinite; }
@keyframes dust-converge {
  0%,100% { opacity:0; transform:translate3d(0,0,0); }
  28% { opacity:.65; }
  80% { opacity:0; transform:translate3d(var(--dust-x),var(--dust-y),0); }
}
</style>
