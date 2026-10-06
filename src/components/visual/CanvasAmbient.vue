<template>
  <div ref="host" class="canvas-ambient" :class="{ 'is-enabled': enabled }" aria-hidden="true">
    <TransitionGroup name="ambient-light">
      <div v-for="layer in layers" :key="layer.id" class="canvas-ambient-frame" :style="frameStyle(layer)">
        <i class="ambient-edge ambient-top"></i><i class="ambient-edge ambient-right"></i>
        <i class="ambient-edge ambient-bottom"></i><i class="ambient-edge ambient-left"></i>
      </div>
    </TransitionGroup>
  </div>
</template>
<script setup lang="ts">
import { ref, watch, type CSSProperties } from 'vue'
import { useResizeObserver } from '@vueuse/core'
const props=defineProps<{ colors:string[]; aspect:number; enabled:boolean }>()
const host=ref<HTMLElement | null>(null)
const size=ref({width:0,height:0})
interface Layer { id:number; colors:string[]; aspect:number }
const layers=ref<Layer[]>([])
let revision=0
watch(() => [props.colors,props.aspect] as const,([colors,aspect]) => {
  // Keep the previous light until the replacement is decoded and sampled.
  layers.value=colors.length===8 ? [{id:++revision,colors:[...colors],aspect}] : []
},{immediate:true})
useResizeObserver(host,() => { const rect=host.value?.getBoundingClientRect(); if (rect) size.value={width:rect.width,height:rect.height} })
function frameStyle(layer:Layer):CSSProperties {
  const {width,height}=size.value
  const fitWidth=Math.min(width,height*layer.aspect), fitHeight=fitWidth/layer.aspect
  const style:Record<string,string>={left:`${(width-fitWidth)/2}px`,top:`${(height-fitHeight)/2}px`,width:`${fitWidth}px`,height:`${fitHeight}px`}
  layer.colors.forEach((color,index) => { style[`--edge-${index}`]=color })
  return style
}
</script>
<style scoped>
.canvas-ambient { position:absolute; inset:var(--s-2); pointer-events:none; opacity:0; transition:opacity 480ms ease; overflow:visible; }
.canvas-ambient.is-enabled { opacity:1; }
.canvas-ambient-frame { position:absolute; }
.ambient-edge { position:absolute; display:block; pointer-events:none; }
/* Static gradients are rasterized once. Only old/new layer opacity animates;
   each halo lives outside the actual object-contain bounds, never full-canvas tint. */
.ambient-top,.ambient-bottom { left:0; width:100%; height:clamp(24px,5cqw,76px); mask-image:linear-gradient(90deg,transparent,#000 16%,#000 84%,transparent); }
.ambient-left,.ambient-right { top:0; height:100%; width:clamp(24px,5cqw,76px); mask-image:linear-gradient(transparent,#000 16%,#000 84%,transparent); }
.ambient-top { bottom:100%; background:radial-gradient(ellipse at 25% 100%,rgb(var(--edge-0) / .21),transparent 70%),radial-gradient(ellipse at 75% 100%,rgb(var(--edge-1) / .21),transparent 70%); }
.ambient-right { left:100%; background:radial-gradient(ellipse at 0% 25%,rgb(var(--edge-2) / .21),transparent 70%),radial-gradient(ellipse at 0% 75%,rgb(var(--edge-3) / .21),transparent 70%); }
.ambient-bottom { top:100%; background:radial-gradient(ellipse at 75% 0%,rgb(var(--edge-4) / .21),transparent 70%),radial-gradient(ellipse at 25% 0%,rgb(var(--edge-5) / .21),transparent 70%); }
.ambient-left { right:100%; background:radial-gradient(ellipse at 100% 75%,rgb(var(--edge-6) / .21),transparent 70%),radial-gradient(ellipse at 100% 25%,rgb(var(--edge-7) / .21),transparent 70%); }
.ambient-light-enter-active,.ambient-light-leave-active { transition:opacity 650ms ease; }
.ambient-light-enter-from,.ambient-light-leave-to { opacity:0; }
@media(prefers-reduced-motion:reduce) {
  :root:not([data-motion='full']) :is(.canvas-ambient,.ambient-light-enter-active,.ambient-light-leave-active) { transition:none; }
}
:root:is([data-motion='reduce'],[data-motion='reduced']) :is(.canvas-ambient,.ambient-light-enter-active,.ambient-light-leave-active) { transition:none; }
</style>
