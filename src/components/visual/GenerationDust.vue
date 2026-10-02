<template>
  <div ref="root" class="generation-flow" :class="{ 'is-running': canAnimate && !lowEffects, 'is-framed': framed }" aria-hidden="true">
    <svg v-for="(path, index) in threads" :key="index" class="flow-thread" :class="`flow-thread-${index}`" viewBox="0 0 600 400" fill="none">
      <path class="flow-wash" :d="path" />
      <path class="flow-line" :d="path" />
      <path class="flow-fine" :d="path" transform="translate(0 6)" />
    </svg>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useVisualActivity } from '@/composables/useVisualActivity'
withDefaults(defineProps<{ framed?: boolean }>(), { framed: false })
const root = ref<HTMLElement | null>(null)
const { canAnimate, lowEffects } = useVisualActivity(root)
// Three ink-like arcs leave the portrait/status centre open. Rasterized once;
// only transform/opacity changes during a long generation, with no JS frame loop.
const threads = [
  'M 46 260 C 15 172 128 64 254 88 C 323 101 310 165 223 144 C 126 119 160 40 356 66 C 446 78 500 137 537 173',
  'M 76 277 C 140 340 304 361 419 313 C 526 268 553 164 481 151 C 428 142 426 204 495 227',
  'M 64 192 C 68 110 177 57 253 79 M 367 324 C 476 315 543 249 537 188',
]
</script>

<style scoped>
.generation-flow { position:absolute; inset:0; overflow:hidden; pointer-events:none; z-index:0; color:color-mix(in srgb,var(--accent) 38%,var(--text-muted)); }
.flow-thread { position:absolute; width:min(100%,680px); height:100%; left:50%; top:0; transform:translateX(-50%); opacity:.2; }
.flow-thread-1 { color:color-mix(in srgb,var(--accent-violet) 32%,var(--text-muted)); }
.flow-wash { stroke:currentColor; stroke-width:16; opacity:.055; }
.flow-line { stroke:currentColor; stroke-width:1.2; opacity:.6; stroke-linecap:round; }
.flow-fine { stroke:currentColor; stroke-width:.5; opacity:.32; stroke-linecap:round; }
.is-running .flow-thread { animation:magic-flow 5.8s ease-in-out infinite; }
.is-running .flow-thread-1 { animation-delay:-2.8s; animation-duration:7.2s; }
.is-running .flow-thread-2 { animation-delay:-1.6s; animation-duration:6.4s; }
/* The retained result remains the protagonist; restrict the threads to the image
 * interior and keep the heading/actions outside the decorative area. */
.is-framed { inset:52px 0 58px; z-index:1; }
.is-framed .flow-thread { opacity:.14; }
.is-framed.is-running .flow-thread { animation-name:magic-flow-framed; }
@keyframes magic-flow {
  0%,100% { opacity:.18; transform:translate3d(-50%,3px,0) rotate(-2deg); }
  50% { opacity:.54; transform:translate3d(-49%,-4px,0) rotate(2deg); }
}
@keyframes magic-flow-framed {
  0%,100% { opacity:.1; transform:translate3d(-50%,3px,0) rotate(-2deg); }
  50% { opacity:.28; transform:translate3d(-49%,-4px,0) rotate(2deg); }
}
</style>
