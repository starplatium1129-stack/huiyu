<template>
  <div ref="host" class="generation-particles" aria-hidden="true">
    <canvas ref="canvas"></canvas>
    <span class="generation-particle-palette"><i class="tone-pink"></i><i class="tone-cyan"></i><i class="tone-violet"></i><i class="tone-highlight"></i></span>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useResizeObserver } from '@vueuse/core'
import { useVisualActivity } from '@/composables/useVisualActivity'
import { registerParticleFrame } from '@/utils/particleScheduler'

const props = defineProps<{ progress: number | null }>()
const host = ref<HTMLElement | null>(null)
const canvas = ref<HTMLCanvasElement | null>(null)
const { canPresent, canAnimate, lowEffects, appearanceRevision } = useVisualActivity(host)
interface Point { latitude: number; phase: number; tone: number; layer: number; x: number; y: number; depth: number }
let points: Point[] = []
let colors: string[] = []
let sprites: HTMLCanvasElement[] = []
let context: CanvasRenderingContext2D | null = null
let width = 0, height = 0, ratio = 1
let clock = 1500, previousTime: number | null = null
let concentration = props.progress ?? 0
let stopFrames: (() => void) | null = null

function stop() {
  stopFrames?.()
  stopFrames = null
  previousTime = null
}

function preparePalette() {
  if (!host.value) return
  colors = [...host.value.querySelectorAll<HTMLElement>('.generation-particle-palette i')].map(item => getComputedStyle(item).color)
  for (const sprite of sprites) sprite.width = sprite.height = 0
  sprites = colors.slice(0, 3).map(color => {
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
  ratio = Math.min(window.devicePixelRatio || 1, 2)
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
  const count = lowEffects.value ? 120 : 216
  if (points.length === count) return
  points = Array.from({ length: count }, (_, index) => ({
    latitude: Math.acos(1 - 2 * (index + 0.5) / count), phase: index * 2.399963,
    tone: index % 3, layer: 0.88 + index % 3 * 0.06, x: 0, y: 0, depth: 0,
  }))
}

function draw() {
  if (!context || !width || !height || !colors.length) return
  const ctx = context, time = clock / 1000
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
  ctx.clearRect(0, 0, width, height)
  const centerX = width / 2, centerY = height / 2
  const radius = Math.min(width * 0.25, height * 0.4, 100) * (1 - concentration * 0.64)
  const pitch = 0.28 + Math.sin(time * 0.17) * 0.12
  const cosine = Math.cos(pitch), sine = Math.sin(pitch)
  for (const point of points) {
    const angle = point.phase + time * 0.22
    const wave = 1 + Math.sin(point.phase * 0.3 + time * 0.7) * 0.025
    const reach = radius * point.layer * wave
    const x = Math.sin(point.latitude) * Math.cos(angle) * reach
    const y = Math.cos(point.latitude) * reach
    const z = Math.sin(point.latitude) * Math.sin(angle) * reach
    point.x = centerX + x
    point.y = centerY + y * cosine - z * sine
    point.depth = (y * sine + z * cosine) / radius * 0.5 + 0.5
  }
  points.sort((a, b) => a.depth - b.depth)
  for (const point of points) {
    const depth = point.depth, size = 0.65 + depth * 1.35
    const shimmer = 0.92 + Math.sin(time * 0.8 + point.phase) * 0.08
    ctx.fillStyle = colors[point.tone]
    if (!lowEffects.value && depth > 0.66 && point.tone === 0) {
      const spread = size * 5
      ctx.globalAlpha = depth * 0.12
      ctx.drawImage(sprites[point.tone], point.x - spread, point.y - spread, spread * 2, spread * 2)
    }
    ctx.globalAlpha = (0.14 + depth * 0.66) * shimmer
    ctx.beginPath(); ctx.arc(point.x, point.y, size, 0, Math.PI * 2); ctx.fill()
    if (depth > 0.78 && point.tone === 1) {
      ctx.globalAlpha = 0.7
      ctx.fillStyle = colors[3]
      ctx.beginPath(); ctx.arc(point.x, point.y, 0.6, 0, Math.PI * 2); ctx.fill()
    }
  }
  // Sparse moving threads and dust carry direction without outlining a frame.
  if (!lowEffects.value) {
    ctx.lineWidth = 0.7
    for (let index = 0; index < 12; index++) {
      const phase = time * (index % 2 ? 0.12 : -0.1) + index * 2.18
      const span = radius * (1.1 + (index * 0.618 % 1) * 0.4)
      ctx.strokeStyle = colors[index % 3]
      ctx.globalAlpha = 0.07
      ctx.beginPath()
      for (let segment = 0; segment < 5; segment++) {
        const angle = phase - segment * 0.025
        const x = centerX + Math.cos(angle) * span, y = centerY + Math.sin(angle) * span * 0.62
        if (segment === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.stroke()
      ctx.fillStyle = colors[index % 3]
      ctx.globalAlpha = 0.14 + Math.sin(time * 0.6 + index) * 0.035
      ctx.beginPath(); ctx.arc(centerX + Math.cos(phase) * span, centerY + Math.sin(phase) * span * 0.62, 0.8, 0, Math.PI * 2); ctx.fill()
    }
  }
  ctx.globalAlpha = 1
}

function reconcile() {
  stop()
  if (!canPresent.value || !context) return
  preparePoints()
  draw()
  if (canAnimate.value) stopFrames = registerParticleFrame(now => {
    const delta = previousTime === null ? 0 : Math.min(64, now - previousTime)
    previousTime = now
    clock += delta
    if (props.progress !== null) concentration += (props.progress - concentration) * (1 - Math.exp(-delta / 420))
    draw()
  }, lowEffects.value ? 30 : 0)
}

useResizeObserver(host, resize)
watch([canPresent, canAnimate, lowEffects, appearanceRevision], () => { preparePalette(); reconcile() }, { flush: 'post' })
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
.generation-particles { position:relative; isolation:isolate; width:min(100%,clamp(320px,42cqw,420px)); aspect-ratio:1.38; margin-inline:auto; pointer-events:none; }
/* compositor-exempt: A bounded Canvas renders particle depth; cached glow sprites avoid per-frame blur. */
.generation-particles canvas { position:relative; display:block; width:100%; height:100%; }
.generation-particle-palette { position:absolute; width:0; height:0; overflow:hidden; visibility:hidden; }
.tone-pink { color:var(--accent); }
.tone-cyan { color:var(--archive-cyan); }
.tone-violet { color:var(--accent-violet,var(--accent)); }
.tone-highlight { color:var(--text-primary); }
</style>
