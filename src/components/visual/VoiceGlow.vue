<template>
  <div
    ref="containerRef"
    class="voice-glow-container tw:absolute tw:bottom-0 tw:left-0 tw:right-0 tw:pointer-events-none tw:overflow-hidden tw:[z-index:1] tw:[border-bottom-left-radius:inherit] tw:[border-bottom-right-radius:inherit]"
    :class="{
      'is-active': active && canPresent,
      'is-processing': processing,
      'is-low-effects': lowEffects,
      [`variant-${colorVariant}`]: true,
    }"
    aria-hidden="true"
  >
    <canvas ref="canvasRef" class="voice-glow-canvas tw:block tw:w-full tw:pointer-events-none" />
    <canvas ref="strokeRef" class="voice-glow-canvas tw:block tw:w-full tw:pointer-events-none" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
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

const containerRef = ref<HTMLElement | null>(null)
const canvasRef = ref<HTMLCanvasElement | null>(null)
const strokeRef = ref<HTMLCanvasElement | null>(null)
const { canPresent, canAnimate, reducedMotion, lowEffects, appearanceRevision } = useVisualActivity(containerRef)
let stopFrames: (() => void) | null = null
let logicalWidth = 1
let smoothedLevel = 0
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
  const container = containerRef.value
  if (!canvasRef.value || !strokeRef.value || !container) return
  const width = Math.max(1, Math.round(container.getBoundingClientRect().width))
  logicalWidth = width
  const dpr = Math.min(window.devicePixelRatio || 1, 2, 2048 / (width*2))
  const pixelWidth = Math.max(1, Math.round(width*2*dpr))
  const pixelHeight = Math.max(1, Math.round(height.value * dpr))
  container.style.height = `${height.value}px`
  for (const canvas of [canvasRef.value,strokeRef.value]) {
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth
      canvas.height = pixelHeight
    }
    canvas.style.width = `${width*2}px`
    canvas.style.height = `${height.value}px`
  }
  prepareCurve()
}

function stopAnimation(): void {
  stopFrames?.(); stopFrames = null
}

/** Cache the normalized bell once. Its changing height, spread and center are
 * affine transforms; audio frames only update compositor properties. */
function prepareCurve(): void {
  if (!canvasRef.value || !strokeRef.value) return
  const points: [number,number][] = [],w=logicalWidth*2,h=height.value
  for(let i=0;i<=120;i++) {
    const x=i/120*w,bell=Math.exp(-Math.pow(Math.abs(x-logicalWidth)/(logicalWidth*.3),1.8))
    points.push([x,h-bell*h])
  }
  for (const [index,canvas] of [canvasRef.value,strokeRef.value].entries()) {
    const ctx=canvas.getContext('2d'); if (!ctx) continue
    ctx.setTransform(canvas.width/w,0,0,canvas.height/h,0,0);ctx.clearRect(0,0,w,h)
    ctx.beginPath();points.forEach(([x,y],i)=>{if(!i)ctx.moveTo(x,y);else ctx.lineTo(x,y)})
    if (index===0) {
      const gradient=ctx.createLinearGradient(logicalWidth,h,logicalWidth,0)
      gradient.addColorStop(0,colors.primary);gradient.addColorStop(.5,colors.secondary);gradient.addColorStop(1,'transparent')
      ctx.lineTo(w,h);ctx.lineTo(0,h);ctx.closePath();ctx.fillStyle=gradient;ctx.fill()
    } else { ctx.strokeStyle='#ffffff';ctx.lineWidth=1.5;ctx.stroke() }
  }
}

/** Returns whether a further animated frame is useful. Static states never self-schedule. */
function drawFrame(dt: number): boolean {
  const canvas = canvasRef.value
  const stroke = strokeRef.value
  if (!canvas || !stroke) return false
  const target = Math.max(level.value, props.processing ? 0.5 : 0)
  if (reducedMotion.value) smoothedLevel = target
  else {
    const tau = target > smoothedLevel ? 0.12 : 0.45
    smoothedLevel += (target - smoothedLevel) * (1 - Math.exp(-dt / tau))
  }
  const breathe = reducedMotion.value ? 0.5 : 0.5 + 0.5 * Math.sin(2 * Math.PI * animationTime / period.value)
  const effectiveLevel = Math.max(smoothedLevel, (1 - smoothedLevel) * idleStrength.value * breathe)
  const moving = props.processing || idleStrength.value > 0 || target > 0 || smoothedLevel > 0.01
  const shift=props.processing && !reducedMotion.value ? Math.sin(animationTime*2.8)*.32*logicalWidth : 0
  const transform=`translateX(${shift}px) scale(${(.35+.25*effectiveLevel)/.6},${.35+.65*effectiveLevel})`
  canvas.style.transform=stroke.style.transform=transform
  canvas.style.opacity=effectiveLevel>.01 ? String(.35+.65*effectiveLevel) : '0'
  stroke.style.opacity=effectiveLevel>.01 ? String(.2+.7*effectiveLevel) : '0'
  return moving
}

function frame(_now: number, elapsed: number): void {
  if (!props.active || !canAnimate.value) { stopAnimation(); return }
  const dt = Math.min(elapsed/1000,0.1)
  animationTime += dt
  if (!drawFrame(dt)) stopAnimation()
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
  } else if (stopFrames === null) {
    stopFrames = registerParticleFrame(frame, lowEffects.value ? 30 : 0)
  }
}

watch([() => props.active, canPresent, canAnimate, () => props.processing, level, idleStrength, period], refresh, { flush: 'post' })
watch([() => props.colorVariant, appearanceRevision], () => {
  readColors()
  prepareCurve()
  refresh()
}, { flush: 'post' })
watch(height, () => { updateCanvasSize(); refresh() }, { flush: 'post' })
useResizeObserver(containerRef, () => { updateCanvasSize(); refresh() })
watch(lowEffects, () => { stopAnimation(); refresh() }, { flush:'post' })
onMounted(() => { readColors(); updateCanvasSize(); refresh() })
onBeforeUnmount(stopAnimation)
</script>

<style scoped>
.voice-glow-container {
  opacity: 0;
  transition: opacity var(--motion-control, 200ms) var(--ease-out, ease-out);
}
.voice-glow-container.is-active { opacity: 1; }
.voice-glow-canvas {
  position:absolute; bottom:0; left:-50%; transform-origin:50% 100%;
  filter: drop-shadow(0 -2px 8px var(--accent-glow, rgba(242, 168, 190, 0.35)));
}
.is-low-effects { transition: none; }
.is-low-effects .voice-glow-canvas { filter: none; }
</style>
