<script setup lang="ts">
defineProps<{ colors: readonly string[] }>()
</script>

<template>
  <span class="palette-fan" aria-hidden="true">
    <span v-for="(color, index) in colors" :key="index" class="palette-leaf"
      :style="{ '--swatch': color, '--leaf': index - (colors.length - 1) / 2 }" />
  </span>
</template>

<style scoped>
.palette-fan { display:grid; place-items:center; width:100%; height:100%; }
.palette-leaf {
  grid-area:1/1;
  width:36px;
  height:70%;
  border:1px solid var(--border-soft);
  border-bottom:5px solid var(--bg-surface);
  border-radius:var(--r-xs);
  background:var(--swatch);
  box-shadow:var(--shadow-sm);
  transform-origin:50% 92%;
  --spread:var(--fan-spread,12px);
  --angle:var(--fan-angle,12deg);
  transform:translateX(calc(var(--leaf) * var(--spread))) rotate(calc(var(--leaf) * var(--angle)));
  transition:transform var(--motion-route-cut) var(--spring-soft);
}
@media (prefers-reduced-motion:reduce) {
  :root:not([data-motion='full']) .palette-leaf { --spread:12px; --angle:12deg; transition:none; }
}
:root:is([data-motion='reduce'],[data-motion='reduced']) .palette-leaf { --spread:12px; --angle:12deg; transition:none; }
@media (forced-colors:active) { .palette-leaf { forced-color-adjust:none; border:1px solid CanvasText; } }
</style>
