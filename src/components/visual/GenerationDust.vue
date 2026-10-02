<template>
  <div ref="root" class="generation-flow" :class="{ 'is-running': canAnimate && !lowEffects, 'is-framed': framed }" aria-hidden="true">
    <i
      v-for="(pixel, index) in pixels"
      :key="index"
      class="generation-pixel"
      :class="{ 'pixel-violet': pixel.x + pixel.y > 4 }"
      :style="{ '--x': pixel.x, '--y': pixel.y, '--dx': pixel.x - 2, '--dy': pixel.y - 2, '--delay': `${-(pixel.x + pixel.y) * .13}s` }"
    />
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useVisualActivity } from '@/composables/useVisualActivity'
withDefaults(defineProps<{ framed?: boolean }>(), { framed: false })
const root = ref<HTMLElement | null>(null)
const { canAnimate, lowEffects } = useVisualActivity(root)
// One compact pixel field belongs beside the status, never over the reference or
// result. A diagonal wave resolves 25 fixed pixels without JS painting or timers.
const pixels = Array.from({ length: 25 }, (_, index) => ({ x: index % 5, y: Math.floor(index / 5) }))
</script>

<style scoped>
.generation-flow {
  --pixel-step:11px; --pixel-size:8px; --pixel-inset:6px; --pixel-travel:2px;
  position:relative; display:inline-block; flex:none; width:64px; height:64px;
  pointer-events:none; vertical-align:middle;
  color:color-mix(in srgb,var(--accent) 76%,var(--text-secondary));
}
.generation-pixel {
  position:absolute;
  left:calc(var(--pixel-inset) + var(--x) * var(--pixel-step));
  top:calc(var(--pixel-inset) + var(--y) * var(--pixel-step));
  width:var(--pixel-size); height:var(--pixel-size); background:currentColor; opacity:.56;
}
.pixel-violet { color:color-mix(in srgb,var(--accent-violet) 72%,var(--text-secondary)); }
.is-running .generation-pixel {
  animation:pixel-weave 2.1s cubic-bezier(.22,.61,.36,1) infinite;
  animation-delay:var(--delay); will-change:transform,opacity;
}
/* Compact inline version for the retained-result heading; never an image layer. */
.is-framed {
  --pixel-step:4px; --pixel-size:3px; --pixel-inset:1.5px; --pixel-travel:.5px;
  width:22px; height:22px;
}
@keyframes pixel-weave {
  0%,100% {
    opacity:.22;
    transform:translate3d(calc(var(--dx) * var(--pixel-travel)),calc(var(--dy) * var(--pixel-travel)),0) scale(.55);
  }
  38%,58% { opacity:.94; transform:translate3d(0,0,0) scale(1); }
  82% { opacity:.46; transform:translate3d(0,0,0) scale(.78); }
}
</style>
