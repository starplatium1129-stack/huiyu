<template>
  <div
    ref="containerRef"
    class="voice-glow-container"
    :class="{
      'is-active': active && canPresent,
      'is-processing': processing,
      'is-low-effects': lowEffects,
      [`variant-${colorVariant}`]: true,
    }"
    aria-hidden="true"
  >
    <canvas ref="canvasRef" class="voice-glow-canvas" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useResizeObserver } from '@vueuse/core'
import { useVisualActivity } from '@/composables/useVisualActivity'

const props = withDefaults(defineProps<{
  active?: boolean
  /** Real audio level, normalized to 0..1; this component never requests a microphone. */
  level?: number
  processing?: boolean
  breatheDuration?: number
  maxHeight?: number
  colorVariant?: 'dual' | 'accent' | 'violet'
  idleStrength?: number
}>(), {
  active: true, level: 0, processing: false, breatheDuration: 4.6,
  maxHeight: 28, colorVariant: 'dual', idleStrength: 0.22,
})

const containerRef = ref<HTMLElement | null>(null)
const canvasRef = ref<HTMLCanvasElement | null>(null)
const { canPresent, canAnimate, reducedMotion, lowEffects, appearanceRevision } = useVisualActivity(containerRef)
let rafId: number | null = null
let smoothedLevel = 0
let lastTime: number | null = null
let animationTime = 0
let colors = { primary: '#F2A8BE', secondary: '#B784F6' }
const clampUnit = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0
const level = computed(() => clampUnit(props.level))
const idleStrength = computed(() => clampUnit(props.idleStrength))
const height = computed(() => Number.isFinite(props.maxHeight) ? Math.max(1, Math.min(120, props.maxHeight)) : 28)
const period = computed(() => Number.isFinite(props.breatheDuration) ? Math.max(0.5, props.breatheDuration) : 4.6)

function readColors(): void {
  if (!containerRef.value) return
  const styles = getComputedStyle(containerRef.value)
  const accent = styles.getPropertyValue('--accent').trim() || '#F2A8BE'
  const violet = styles.getPropertyValue('--accent-violet').trim() || '#B784F6'
  colors = props.colorVariant === 'accent' ? { primary: accent, secondary: accent }
    : props.colorVariant === 'violet' ? { primary: violet, secondary: violet } : { primary: accent, secondary: violet }
}

function updateCanvasSize(): void {
  const canvas = canvasRef.value
  const container = containerRef.value
  if (!canvas || !container) return
  const width = Math.max(1, Math.round(container.getBoundingClientRect().width))
  const dpr = Math.min(window.devicePixelRatio || 1, 2, 2048 / width)
  const pixelWidth = Math.max(1, Math.round(width * dpr))
  const pixelHeight = Math.max(1, Math.round(height.value * dpr))
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth
    canvas.height = pixelHeight
  }
  canvas.style.width = `${width}px`
  canvas.style.height = `${height.value}px`
}

function stopAnimation(): void {
  if (rafId !== null) cancelAnimationFrame(rafId)
  rafId = null
  lastTime = null
}

/** Returns whether a further animated frame is useful. Static states never self-schedule. */
function drawFrame(dt: number): boolean {
  const canvas = canvasRef.value
  const ctx = canvas?.getContext('2d')
  if (!canvas || !ctx) return false
  const target = Math.max(level.value, props.processing ? 0.5 : 0)
  if (reducedMotion.value) smoothedLevel = target
  else {
    const tau = target > smoothedLevel ? 0.12 : 0.45
    smoothedLevel += (target - smoothedLevel) * (1 - Math.exp(-dt / tau))
  }
  const breathe = reducedMotion.value ? 0.5 : 0.5 + 0.5 * Math.sin(2 * Math.PI * animationTime / period.value)
  const effectiveLevel = Math.max(smoothedLevel, (1 - smoothedLevel) * idleStrength.value * breathe)
  const w = canvas.width
  const h = canvas.height
  ctx.clearRect(0, 0, w, h)
  const moving = props.processing || idleStrength.value > 0 || target > 0 || smoothedLevel > 0.01
  if (effectiveLevel <= 0.01) return moving

  const centerX = w * (0.5 + (props.processing && !reducedMotion.value ? Math.sin(animationTime * 2.8) * 0.32 : 0))
  const riseHeight = h * (0.35 + 0.65 * effectiveLevel)
  const gradient = ctx.createLinearGradient(centerX, h, centerX, h - riseHeight)
  gradient.addColorStop(0, colors.primary)
  gradient.addColorStop(0.5, colors.secondary)
  gradient.addColorStop(1, 'transparent')
  const bellSpread = w * (0.35 + 0.25 * effectiveLevel)
  const points: [number, number][] = []
  for (let i = 0; i <= 60; i++) {
    const x = i / 60 * w
    const bell = Math.exp(-Math.pow(Math.abs(x - centerX) / (bellSpread * 0.5), 1.8))
    points.push([x, h - bell * riseHeight])
  }
  ctx.save()
  ctx.fillStyle = gradient
  ctx.globalAlpha = Math.min(1, 0.35 + 0.65 * effectiveLevel)
  ctx.beginPath()
  ctx.moveTo(0, h)
  for (const [x, y] of points) ctx.lineTo(x, y)
  ctx.lineTo(w, h)
  ctx.closePath()
  ctx.fill()
  ctx.beginPath()
  points.forEach(([x, y], index) => { if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y) })
  ctx.strokeStyle = '#ffffff'
  ctx.lineWidth = Math.max(1, 1.5 * effectiveLevel)
  ctx.globalAlpha = Math.min(1, 0.2 + 0.7 * effectiveLevel)
  ctx.stroke()
  ctx.restore()
  return moving
}

function frame(now: number): void {
  rafId = null
  if (!props.active || !canAnimate.value) return
  const dt = lastTime === null ? 1 / 60 : Math.max(0, Math.min((now - lastTime) / 1000, 0.1))
  lastTime = now
  animationTime += dt
  if (drawFrame(dt)) rafId = requestAnimationFrame(frame)
}

function refresh(): void {
  if (!props.active || !canPresent.value) {
    stopAnimation()
    smoothedLevel = 0
    return
  }
  if (reducedMotion.value) {
    stopAnimation()
    drawFrame(0)
  } else if (rafId === null) {
    rafId = requestAnimationFrame(frame)
  }
}

watch([() => props.active, canPresent, canAnimate, () => props.processing, level, idleStrength, period], refresh, { flush: 'post' })
watch([() => props.colorVariant, appearanceRevision], () => {
  readColors()
  refresh()
}, { flush: 'post' })
watch(height, () => { updateCanvasSize(); refresh() }, { flush: 'post' })
useResizeObserver(containerRef, () => { updateCanvasSize(); refresh() })
onMounted(() => { updateCanvasSize(); readColors(); refresh() })
onBeforeUnmount(stopAnimation)
</script>

<style scoped>
.voice-glow-container {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  pointer-events: none;
  overflow: hidden;
  z-index: 1;
  border-bottom-left-radius: inherit;
  border-bottom-right-radius: inherit;
  opacity: 0;
  transition: opacity var(--motion-control, 200ms) var(--ease-out, ease-out);
}
.voice-glow-container.is-active { opacity: 1; }
.voice-glow-canvas {
  display: block;
  width: 100%;
  pointer-events: none;
  filter: drop-shadow(0 -2px 8px var(--accent-glow, rgba(242, 168, 190, 0.35)));
}
.is-low-effects { transition: none; }
.is-low-effects .voice-glow-canvas { filter: none; }
</style>
