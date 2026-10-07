<template>
  <div class="generation-particles" aria-hidden="true">
    <div ref="host" class="generation-particle-surface" :class="{ 'is-continuation': continuation }">
    <GenerationBloomShader v-if="loadShader && !shaderFailed && !lowEffects" :progress="progress" :colors="colors"
      :present="canPresent" :animate="canAnimate" @unavailable="shaderFailed = true" />
    <canvas ref="canvas"></canvas>
    <span class="generation-particle-palette"><i class="tone-pink"></i><i class="tone-cyan"></i><i class="tone-violet"></i><i class="tone-highlight"></i></span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useResizeObserver } from '@vueuse/core'
import { useVisualActivity } from '@/composables/useVisualActivity'
import { registerParticleFrame } from '@/utils/particleScheduler'
import { visibleGenerationPigment } from '@/utils/generationPalette'
import type { GenerationContinuation } from '@/utils/canvasTextureParticles'

const props = defineProps<{ progress: number | null; palette?: readonly string[]; continuation?: GenerationContinuation }>()
const host = ref<HTMLElement | null>(null)
const canvas = ref<HTMLCanvasElement | null>(null)
const { canPresent, canAnimate, lowEffects, appearanceRevision } = useVisualActivity(host)
const loadShader = ref(false), shaderFailed = ref(false)
const GenerationBloomShader = defineAsyncComponent({
  loader: () => import('./GenerationBloomShader.vue'),
  onError: (_error, _retry, fail) => { shaderFailed.value = true; fail() },
})
interface Point { phase: number; tone: number; x: number; y: number; depth: number }
let points: Point[] = []
const colors = ref<string[]>([])
let sprites: HTMLCanvasElement[] = []
let context: CanvasRenderingContext2D | null = null
let width = 0, height = 0, ratio = 1
let clock = props.continuation?.clock ?? 1500
let rotation = props.continuation?.rotation ?? .27
let concentration = props.continuation?.concentration ?? props.progress ?? 0
let stopFrames: (() => void) | null = null

function stop() {
  stopFrames?.()
  stopFrames = null
}

function preparePalette() {
  if (!canPresent.value || !host.value) return
  colors.value = [...host.value.querySelectorAll<HTMLElement>('.generation-particle-palette i')].map(item => getComputedStyle(item).color)
  if (props.palette?.length === 3) {
    const light = host.value.closest('[data-theme]')?.getAttribute('data-theme') === 'light'
    colors.value.splice(0, 3, ...props.palette.map(color => `rgb(${visibleGenerationPigment(color, light)})`))
  }
  for (const sprite of sprites) sprite.width = sprite.height = 0
  sprites = colors.value.slice(0, 3).map(color => {
    const sprite = document.createElement('canvas')
    sprite.width = sprite.height = 40
    const paint = sprite.getContext('2d')
    if (paint) {
      const glow = paint.createRadialGradient(20, 20, 0, 20, 20, 20)
      glow.addColorStop(0, color)
      glow.addColorStop(1, 'transparent')
      paint.fillStyle = glow
      paint.fillRect(0, 0, 40, 40)
    }
    return sprite
  })
}

function resize() {
  if (!host.value || !canvas.value) return
  const bounds = host.value.getBoundingClientRect()
  if (!bounds.width || !bounds.height) return
  width = bounds.width; height = bounds.height
  // Spend resolution on the local effect, never stretch a stage-sized low-res bitmap.
  ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(600_000 / (width * height)))
  const pixelWidth = Math.round(width * ratio), pixelHeight = Math.round(height * ratio)
  if (canvas.value.width !== pixelWidth || canvas.value.height !== pixelHeight) {
    canvas.value.width = pixelWidth
    canvas.value.height = pixelHeight
  }
  context = canvas.value.getContext('2d')
  if (canPresent.value) draw()
  reconcile()
}

function preparePoints() {
  const count = lowEffects.value ? 3 : 6
  if (points.length === count) return
  points = Array.from({ length: count }, (_, index) => ({
    phase: Math.floor(index/3)*Math.PI,
    tone: index % 3, x: 0, y: 0, depth: 0,
  }))
}

function draw() {
  if (!context || !width || !height || !colors.value.length) return
  const ctx = context, time = clock / 1000, pigments = colors.value
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
  ctx.clearRect(0, 0, width, height)
  const centerX = width / 2, centerY = height / 2
  const smooth = (start: number, end: number) => {
    const t = Math.max(0, Math.min(1, (concentration - start) / (end - start)))
    return t * t * (3 - 2 * t)
  }
  const formed = smooth(.08, .66), finishing = smooth(.65, .98)
  const radius = Math.min(width * .29, height * .3, 116) * (1 - formed * .1 - finishing * .28)
  const orbit = (angle: number, band: number) => {
    const tilt = (-.64 + band*.61) * (1 - finishing * .75) + Math.sin(time*.17+band)*.075 * (1 - finishing)
    const x = Math.cos(angle)*radius*(.86+band*.08)
    const y = Math.sin(angle)*radius*(.86+band*.08)*(.31+band*.035+formed*.1-finishing*.2)+Math.sin(angle*2+time*.12)*2.5*(1-finishing)
    return { x:centerX+x*Math.cos(tilt)-y*Math.sin(tilt), y:centerY+x*Math.sin(tilt)+y*Math.cos(tilt) }
  }
  for (let band=0; band<3; band++) {
    ctx.strokeStyle=pigments[band]; ctx.globalAlpha=.32+finishing*.08; ctx.lineWidth=1
    ctx.beginPath()
    for (let segment=0; segment<=128; segment++) {
      const p=orbit(segment/128*Math.PI*2,band)
      if (!segment) ctx.moveTo(p.x,p.y); else ctx.lineTo(p.x,p.y)
    }
    ctx.stroke()
  }
  for (const point of points) {
    const angle = point.phase + rotation*(point.tone === 1 ? -1.6 : 1.85)+point.tone*1.64
    const p=orbit(angle,point.tone)
    point.x=p.x; point.y=p.y; point.depth=Math.sin(angle)*.5+.5
  }
  points.sort((a, b) => a.depth - b.depth)
  // Continuous fine trails replace dotted tails; the original orbit and collapse remain.
  if (!lowEffects.value) for (const point of points) {
    const direction = point.tone === 1 ? -1 : 1
    const angle = point.phase + rotation*(direction < 0 ? -1.6 : 1.85)+point.tone*1.64
    ctx.strokeStyle=pigments[point.tone]; ctx.globalAlpha=.65; ctx.lineWidth=1.25
    ctx.beginPath()
    for (let tail=24; tail>=0; tail--) {
      const p = orbit(angle-direction*tail*.018, point.tone)
      if (tail===24) ctx.moveTo(p.x,p.y); else ctx.lineTo(p.x,p.y)
    }
    ctx.stroke()
  }
  for (const point of points) {
    const size = 1.4
    const shimmer = 0.92 + Math.sin(time * 0.8 + point.phase) * 0.08
    ctx.fillStyle = pigments[point.tone]
    if (!lowEffects.value) {
      const spread = size * 2.4+1.5
      ctx.globalAlpha = .08
      ctx.drawImage(sprites[point.tone], point.x - spread, point.y - spread, spread * 2, spread * 2)
    }
    ctx.globalAlpha = .95 * shimmer
    ctx.beginPath(); ctx.arc(point.x, point.y, size, 0, Math.PI * 2); ctx.fill()
    ctx.globalAlpha = 0.7
    ctx.fillStyle = pigments[3]
    ctx.beginPath(); ctx.arc(point.x, point.y, 0.6, 0, Math.PI * 2); ctx.fill()
  }
  ctx.globalAlpha = 1
}

function reconcile() {
  stop()
  if (canAnimate.value && !lowEffects.value && 'WebGL2RenderingContext' in window) loadShader.value = true
  if (!canPresent.value || !context) return
  preparePoints()
  draw()
  if (canAnimate.value) stopFrames = registerParticleFrame((_now, delta = 0) => {
    clock += delta
    if (props.progress !== null) concentration += (props.progress - concentration) * (1 - Math.exp(-delta / 420))
    rotation += delta / 1000 * (.18 + concentration * .34)
    draw()
  }, lowEffects.value ? 30 : 0)
}

useResizeObserver(host, resize)
watch([canPresent, canAnimate, lowEffects, appearanceRevision, () => props.palette], () => { preparePalette(); reconcile() }, { flush: 'post' })
watch(() => props.progress, progress => {
  if (!canAnimate.value && canPresent.value) {
    if (progress !== null) concentration = progress
    draw()
  }
}, { flush: 'post' })
onMounted(() => { preparePalette(); resize() })
onBeforeUnmount(() => {
  stop()
  for (const sprite of sprites) sprite.width = sprite.height = 0
  sprites = []; points = []; context = null
  // Vue retains this DOM during the parent's leave transition. Keep its last
  // bitmap for the collapse/fade; the DOM releases it when that transition ends.
})
</script>

<style scoped>
.generation-particles { position:relative; isolation:isolate; display:grid; place-items:center; width:100%; height:100%; margin-inline:auto; pointer-events:none; }
.generation-particle-surface { position:relative; width:min(100%,480px); max-height:100%; aspect-ratio:1.38; animation:generation-line-arrival 420ms ease-out both; }
@keyframes generation-line-arrival { from { opacity:0; } to { opacity:1; } }
.generation-particle-surface.is-continuation { animation:none; }
.generation-particle-surface.is-continuation :deep(.generation-bloom) { animation:generation-line-arrival 600ms ease-out both; }
:global(:root:is([data-motion='reduce'],[data-motion='reduced'])) .generation-particle-surface { animation:none; }
@media (prefers-reduced-motion:reduce) { :global(:root:not([data-motion='full'])) .generation-particle-surface { animation:none; } }
/* compositor-exempt: A bounded Canvas renders particle depth; cached glow sprites avoid per-frame blur. */
.generation-particle-surface > canvas:not(.generation-bloom) { position:relative; display:block; width:100%; height:100%; }
.generation-particle-palette { position:absolute; width:0; height:0; overflow:hidden; visibility:hidden; }
.tone-pink { color:var(--accent); }
.tone-cyan { color:var(--archive-cyan); }
.tone-violet { color:var(--accent-violet,var(--accent)); }
.tone-highlight { color:var(--text-primary); }
</style>
