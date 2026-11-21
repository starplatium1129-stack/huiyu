<template>
  <div
    ref="containerRef"
    class="voice-glow-container tw:absolute tw:bottom-0 tw:left-0 tw:right-0 tw:pointer-events-none tw:overflow-hidden tw:[z-index:1] tw:[border-bottom-left-radius:inherit] tw:[border-bottom-right-radius:inherit]"
    :class="{
      'is-active': active && canPresent,
      'is-processing': processing,
      'is-low-effects': lowEffects,
      'is-reduced': reducedMotion,
      [`variant-${colorVariant}`]: true,
    }"
    :data-reduced-motion="reducedMotion"
    :style="{ height: `${height}px` }"
    aria-hidden="true"
  >
    <span
      v-if="reducedMotion"
      class="voice-glow-static"
      :class="{ 'is-speaking': isInputActive }"
    />
    <template v-else>
      <canvas ref="canvasRef" class="voice-glow-canvas tw:block tw:w-full tw:pointer-events-none" />
      <canvas ref="strokeRef" class="voice-glow-canvas tw:block tw:w-full tw:pointer-events-none" />
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onActivated, onDeactivated, onBeforeUnmount } from 'vue'
import { useResizeObserver } from '@vueuse/core'
import { useVisualActivity } from '@/composables/useVisualActivity'
import { registerParticleFrame } from '@/utils/particleScheduler'

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

const IDLE_EPSILON = 0.01
const containerRef = ref<HTMLElement | null>(null)
const canvasRef = ref<HTMLCanvasElement | null>(null)
const strokeRef = ref<HTMLCanvasElement | null>(null)
const { canPresent, canAnimate, reducedMotion, lowEffects, appearanceRevision } = useVisualActivity(containerRef)
let stopFrames: (() => void) | null = null
let logicalWidth = 0
let smoothedLevel = 0
let animationTime = 0
let colors = { primary: '#F2A8BE', secondary: '#B784F6', stroke: '#edf3fa', glow: 'rgba(242, 168, 190, 0.35)' }
const clampUnit = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0
const level = computed(() => clampUnit(props.level))
const idleStrength = computed(() => clampUnit(props.idleStrength))
const isInputActive = computed(() => level.value > IDLE_EPSILON || props.processing)
const height = computed(() => Number.isFinite(props.maxHeight) ? Math.max(1, Math.min(120, props.maxHeight)) : 28)
const period = computed(() => Number.isFinite(props.breatheDuration) ? Math.max(0.5, props.breatheDuration) : 4.6)

function readColors(): void {
  if (!containerRef.value) return
  const styles = getComputedStyle(containerRef.value)
  const accent = styles.getPropertyValue('--accent').trim() || styles.getPropertyValue('--character-accent').trim() || '#F2A8BE'
  const violet = styles.getPropertyValue('--accent-violet').trim() || '#B784F6'
  const stroke = styles.getPropertyValue('--text-primary').trim() || '#edf3fa'
  const glow = styles.getPropertyValue('--accent-glow').trim() || 'rgba(242, 168, 190, 0.35)'
  colors = props.colorVariant === 'accent' ? { primary: accent, secondary: accent, stroke, glow }
    : props.colorVariant === 'violet' ? { primary: violet, secondary: violet, stroke, glow }
      : { primary: accent, secondary: violet, stroke, glow }
}

function updateCanvasSize(measuredWidth: number): void {
  const width = Math.max(1, Math.round(measuredWidth))
  logicalWidth = width
  if (reducedMotion.value || !canvasRef.value || !strokeRef.value) return
  const dpr = Math.min(window.devicePixelRatio || 1, 2, 2048 / (width * 2))
  const pixelWidth = Math.max(1, Math.round(width * 2 * dpr))
  const pixelHeight = Math.max(1, Math.round(height.value * dpr))
  for (const canvas of [canvasRef.value, strokeRef.value]) {
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth
      canvas.height = pixelHeight
    }
    canvas.style.width = `${width * 2}px`
    canvas.style.height = `${height.value}px`
  }
  prepareCurve()
}

function stopAnimation(): void {
  stopFrames?.()
  stopFrames = null
}

/** Pre-bake the soft radial bloom and bell curve once per resize/theme change.
 * Active audio frames only mutate compositor transform/opacity without per-frame filter passes. */
function prepareCurve(): void {
  if (reducedMotion.value || !canvasRef.value || !strokeRef.value || !logicalWidth) return
  const points: [number, number][] = []
  const w = logicalWidth * 2
  const h = height.value
  const bellHeight = h * 0.78
  for (let i = 0; i <= 120; i++) {
    const x = i / 120 * w
    const bell = Math.exp(-Math.pow(Math.abs(x - logicalWidth) / (logicalWidth * 0.3), 1.8))
    points.push([x, h - bell * bellHeight])
  }
  for (const [index, canvas] of [canvasRef.value, strokeRef.value].entries()) {
    const ctx = canvas.getContext('2d')
    if (!ctx) continue
    ctx.setTransform(canvas.width / w, 0, 0, canvas.height / h, 0, 0)
    ctx.clearRect(0, 0, w, h)
    if (index === 0) {
      if (!lowEffects.value) {
        // Pre-rendered radial glow layer replaces expensive per-frame CSS drop-shadow().
        const haloRadius = Math.max(h * 1.15, logicalWidth * 0.34)
        ctx.save()
        ctx.translate(logicalWidth, h)
        ctx.scale(haloRadius / h, 1)
        const halo = ctx.createRadialGradient(0, 0, h * 0.08, 0, 0, h)
        halo.addColorStop(0, colors.glow)
        halo.addColorStop(0.55, colors.glow)
        halo.addColorStop(1, 'transparent')
        ctx.globalAlpha = 0.55
        ctx.fillStyle = halo
        ctx.fillRect(-h, -h, h * 2, h)
        ctx.restore()
      }
      ctx.beginPath()
      points.forEach(([x, y], i) => { if (!i) ctx.moveTo(x, y); else ctx.lineTo(x, y) })
      const gradient = ctx.createLinearGradient(logicalWidth, h, logicalWidth, h - bellHeight)
      gradient.addColorStop(0, colors.primary)
      gradient.addColorStop(0.54, colors.secondary)
      gradient.addColorStop(1, 'transparent')
      ctx.lineTo(w, h)
      ctx.lineTo(0, h)
      ctx.closePath()
      ctx.fillStyle = gradient
      ctx.fill()
    } else {
      ctx.beginPath()
      points.forEach(([x, y], i) => { if (!i) ctx.moveTo(x, y); else ctx.lineTo(x, y) })
      ctx.strokeStyle = colors.stroke
      ctx.lineWidth = 1.5
      ctx.stroke()
    }
  }
}

/** Returns whether another animated frame is needed. Idle states paint once and sleep RAF. */
function drawFrame(dt: number): boolean {
  const canvas = canvasRef.value
  const stroke = strokeRef.value
  if (!canvas || !stroke) return false
  const target = Math.max(level.value > IDLE_EPSILON ? level.value : 0, props.processing ? 0.5 : 0)
  if (dt > 0) {
    const tau = target > smoothedLevel ? 0.12 : 0.32
    smoothedLevel += (target - smoothedLevel) * (1 - Math.exp(-dt / tau))
    if (target === 0 && smoothedLevel <= IDLE_EPSILON) smoothedLevel = 0
  } else {
    smoothedLevel = target
  }
  const activeMotion = isInputActive.value || smoothedLevel > IDLE_EPSILON
  const breathe = activeMotion ? 0.5 + 0.5 * Math.sin(2 * Math.PI * animationTime / period.value) : 0.5
  const effectiveLevel = Math.max(smoothedLevel, (1 - smoothedLevel) * idleStrength.value * breathe)
  const shift = props.processing ? Math.sin(animationTime * 2.8) * 0.32 * logicalWidth : 0
  const transform = `translateX(${shift}px) scale(${(0.35 + 0.25 * effectiveLevel) / 0.6},${0.35 + 0.65 * effectiveLevel})`
  canvas.style.transform = stroke.style.transform = transform
  canvas.style.opacity = effectiveLevel > IDLE_EPSILON ? String(0.35 + 0.65 * effectiveLevel) : '0'
  stroke.style.opacity = effectiveLevel > IDLE_EPSILON ? String(0.2 + 0.7 * effectiveLevel) : '0'
  return activeMotion
}

function frame(_now: number, elapsed: number): void {
  if (!props.active || !canAnimate.value) { stopAnimation(); return }
  const dt = Math.min(elapsed / 1000, 0.1)
  animationTime += dt
  if (!drawFrame(dt)) stopAnimation()
}

function refresh(): void {
  if (!props.active || !canPresent.value || reducedMotion.value) {
    stopAnimation()
    if (!props.active || !canPresent.value) smoothedLevel = 0
    return
  }
  if (!logicalWidth) {
    const measured = containerRef.value?.clientWidth ?? 0
    if (measured > 0) updateCanvasSize(measured)
  }
  if (!logicalWidth || !canvasRef.value || !strokeRef.value) return
  if (!isInputActive.value && smoothedLevel <= IDLE_EPSILON) {
    stopAnimation()
    drawFrame(0)
    return
  }
  if (stopFrames === null && canAnimate.value) {
    stopFrames = registerParticleFrame(frame, lowEffects.value ? 30 : 0)
  }
}

watch([() => props.active, canPresent, canAnimate, reducedMotion, () => props.processing, level, idleStrength, period], refresh, { flush: 'post' })
watch([canvasRef, strokeRef], ([canvas, stroke]) => {
  if (!canvas || !stroke || reducedMotion.value) return
  const measured = logicalWidth || containerRef.value?.clientWidth || 0
  if (measured > 0) updateCanvasSize(measured)
  refresh()
}, { flush: 'post' })
watch([() => props.colorVariant, appearanceRevision], () => {
  readColors()
  prepareCurve()
  refresh()
}, { flush: 'post' })
useResizeObserver(containerRef, ([entry]) => {
  if (!entry?.contentRect.width) return
  updateCanvasSize(entry.contentRect.width)
  refresh()
})
watch(lowEffects, () => {
  stopAnimation()
  prepareCurve()
  refresh()
}, { flush: 'post' })
onMounted(() => { readColors(); refresh() })
onActivated(() => { readColors(); refresh() })
onDeactivated(() => { stopAnimation(); smoothedLevel = 0 })
onBeforeUnmount(() => { stopAnimation(); smoothedLevel = 0 })
</script>

<style scoped>
.voice-glow-container {
  opacity: 0;
  transition: opacity var(--motion-control, 200ms) var(--ease-out, ease-out);
}
.voice-glow-container.is-active { opacity: 1; }
.voice-glow-canvas {
  position: absolute;
  bottom: 0;
  left: -50%;
  transform-origin: 50% 100%;
}
.voice-glow-static {
  position: absolute;
  inset: auto 0 0;
  height: 3px;
  border-radius: var(--r-pill, 999px);
  opacity: 0.44;
  background: linear-gradient(
    90deg,
    transparent 4%,
    var(--character-accent, var(--accent)) 28%,
    var(--accent-violet) 72%,
    transparent 96%
  );
  transition: opacity var(--motion-press, 120ms) var(--ease-out, ease-out);
}
.variant-accent .voice-glow-static {
  background: linear-gradient(90deg, transparent 4%, var(--character-accent, var(--accent)) 50%, transparent 96%);
}
.variant-violet .voice-glow-static {
  background: linear-gradient(90deg, transparent 4%, var(--accent-violet) 50%, transparent 96%);
}
.voice-glow-static.is-speaking { opacity: 0.88; }
.is-low-effects,
.is-reduced { transition: opacity var(--motion-press, 120ms) var(--ease-out, ease-out); }
@media (prefers-reduced-motion: reduce) {
  :root:not([data-motion='full']) .voice-glow-container { transition: opacity var(--motion-press, 120ms) var(--ease-out, ease-out); }
}
:root:is([data-motion='reduce'], [data-motion='reduced'], [data-reduced-motion='true']) .voice-glow-container {
  transition: opacity var(--motion-press, 120ms) var(--ease-out, ease-out);
}
</style>
