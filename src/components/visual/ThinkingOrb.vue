<template>
  <div
    ref="containerRef"
    class="thinking-orb-host"
    :class="{
      [`size-${typeof size === 'string' ? size : 'custom'}`]: true,
      'is-paused': paused || !canAnimate,
      'is-low-effects': lowEffects,
    }"
    role="status"
    :aria-label="ariaLabel || stateLabel"
  >
    <canvas ref="canvasRef" class="thinking-orb-canvas" aria-hidden="true" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useVisualActivity } from '@/composables/useVisualActivity'

export type OrbState = 'working' | 'weaving' | 'searching'

const props = withDefaults(defineProps<{
  state?: OrbState
  size?: 'sm' | 'md' | 'lg' | number
  speed?: number
  /** Freeze the current frame, including when mounted paused. */
  paused?: boolean
  ariaLabel?: string
  colorVariant?: 'dual' | 'accent' | 'violet'
}>(), {
  state: 'working', size: 'md', speed: 1, paused: false, colorVariant: 'dual',
})

const containerRef = ref<HTMLElement | null>(null)
const canvasRef = ref<HTMLCanvasElement | null>(null)
const { canPresent, canAnimate, reducedMotion, lowEffects, appearanceRevision } = useVisualActivity(containerRef)
let rafId: number | null = null
let previousTime: number | null = null
let animationTime = 1500
let painted = false
let colors = { accent: '#F2A8BE', violet: '#B784F6' }

const resolvedPixelSize = computed(() => {
  if (typeof props.size === 'number') return Number.isFinite(props.size) ? Math.max(16, Math.min(256, props.size)) : 48
  return props.size === 'sm' ? 20 : props.size === 'lg' ? 64 : 48
})
const resolvedSpeed = computed(() => Number.isFinite(props.speed) ? Math.max(0, Math.min(4, props.speed)) : 1)
const stateLabel = computed(() => props.state === 'weaving' ? '正在编织画面意境…'
  : props.state === 'searching' ? '正在检索匹配场景…' : '心动画面显影生成中…')

function readColors(): void {
  if (!containerRef.value) return
  const styles = getComputedStyle(containerRef.value)
  const accent = styles.getPropertyValue('--accent').trim() || '#F2A8BE'
  const violet = styles.getPropertyValue('--accent-violet').trim() || '#B784F6'
  colors = props.colorVariant === 'accent' ? { accent, violet: accent }
    : props.colorVariant === 'violet' ? { accent: violet, violet } : { accent, violet }
}

function initCanvas(): void {
  const canvas = canvasRef.value
  if (!canvas) return
  const s = resolvedPixelSize.value
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const pixels = Math.round(s * dpr)
  // Assigning width/height clears the bitmap, even if the value has not changed.
  if (canvas.width !== pixels || canvas.height !== pixels) {
    canvas.width = pixels
    canvas.height = pixels
    painted = false
  }
  canvas.style.width = `${s}px`
  canvas.style.height = `${s}px`
}

interface ParticleDot {
  x: number
  y: number
  z: number
  r: number
  alpha: number
  isHighlight?: boolean
}

function project3D(x: number, y: number, z: number, pitch: number, yaw: number, cx: number, cy: number): [number, number, number] {
  const cosY = Math.cos(yaw)
  const sinY = Math.sin(yaw)
  const x1 = x * cosY - z * sinY
  const z1 = x * sinY + z * cosY
  const cosP = Math.cos(pitch)
  const sinP = Math.sin(pitch)
  return [cx + x1, cy + y * cosP - z1 * sinP, y * sinP + z1 * cosP]
}

/** Drawing is independent of scheduling: a paused orb can still paint a static frame. */
function drawFrame(timeMs: number): boolean {
  const canvas = canvasRef.value
  if (!canvas) return false
  const ctx = canvas.getContext('2d')
  if (!ctx) return false
  const size = canvas.width
  const cx = size / 2
  const cy = size / 2
  const R = size * 0.42
  const t = timeMs / 1000
  const dots: ParticleDot[] = []

  if (props.state === 'weaving') {
    const strands = 3
    const dotsPerStrand = resolvedPixelSize.value < 30 ? 24 : 44
    for (let s = 0; s < strands; s++) {
      const phase = (s / strands) * Math.PI * 2
      for (let i = 0; i < dotsPerStrand; i++) {
        const u = (((i / dotsPerStrand + t * 0.08) % 1) * 2 - 1) * 0.95
        const surf = Math.sqrt(Math.max(0, 1 - u * u))
        const angle = u * Math.PI * 3 + phase
        const weave = 1 + 0.08 * Math.sin(u * Math.PI * 6 + phase * 2 + t * 1.5)
        const rr = surf * R * weave
        const [px, py, pz] = project3D(Math.cos(angle) * rr, u * R * weave, Math.sin(angle) * rr, 0.35, t * 0.4, cx, cy)
        const depth = (pz / R + 1) / 2
        dots.push({ x: px, y: py, z: pz, r: (1.1 + 1.2 * depth) * (size / 64), alpha: 0.25 + 0.75 * depth, isHighlight: depth > 0.75 })
      }
    }
  } else if (props.state === 'searching') {
    const meridians = resolvedPixelSize.value < 30 ? 4 : 8
    const pointsPerMeridian = resolvedPixelSize.value < 30 ? 16 : 28
    const scanAngle = (t * 2.2) % (Math.PI * 2)
    for (let m = 0; m < meridians; m++) {
      const phi = (m / meridians) * Math.PI
      for (let p = 0; p < pointsPerMeridian; p++) {
        const theta = (p / pointsPerMeridian) * Math.PI * 2
        const [px, py, pz] = project3D(R * Math.sin(phi) * Math.cos(theta), R * Math.cos(phi), R * Math.sin(phi) * Math.sin(theta), 0.4, t * 0.2, cx, cy)
        const depth = (pz / R + 1) / 2
        const angleDiff = Math.abs((theta - scanAngle + Math.PI * 4) % (Math.PI * 2) - Math.PI)
        const scanHighlight = Math.max(0, 1 - angleDiff / 0.8)
        dots.push({ x: px, y: py, z: pz, r: (0.9 + scanHighlight * 1.4) * (size / 64), alpha: 0.15 + 0.35 * depth + scanHighlight * 0.5, isHighlight: scanHighlight > 0.4 })
      }
    }
  } else {
    const orbitCount = resolvedPixelSize.value < 30 ? 4 : 8
    const ghostDotsPerOrbit = resolvedPixelSize.value < 30 ? 18 : 32
    for (let o = 0; o < orbitCount; o++) {
      const ro = R * (0.45 + 0.52 * ((o * 1.618) % 1))
      const tiltX = (o * 0.7) % Math.PI
      const tiltY = (o * 1.2) % Math.PI
      const orbitSpeed = (0.4 + 0.5 * ((o * 2.1) % 1)) * (o % 2 === 0 ? 1 : -1)
      for (let k = 0; k < ghostDotsPerOrbit; k++) {
        const a = (k / ghostDotsPerOrbit) * Math.PI * 2
        const [px, py, pz] = project3D(Math.cos(a) * ro, Math.sin(a) * ro * Math.sin(tiltX), Math.sin(a) * ro * Math.cos(tiltY), 0.3, t * 0.15, cx, cy)
        const depth = (pz / ro + 1) / 2
        dots.push({ x: px, y: py, z: pz, r: 0.8 * (size / 64), alpha: 0.12 + 0.28 * depth })
      }
      const particleA = t * orbitSpeed + (o * Math.PI) / 2
      const [px, py, pz] = project3D(Math.cos(particleA) * ro, Math.sin(particleA) * ro * Math.sin(tiltX), Math.sin(particleA) * ro * Math.cos(tiltY), 0.3, t * 0.15, cx, cy)
      const depth = (pz / ro + 1) / 2
      dots.push({ x: px, y: py, z: pz, r: (1.5 + 1.6 * depth) * (size / 64), alpha: 0.6 + 0.4 * depth, isHighlight: true })
    }
  }

  dots.sort((a, b) => a.z - b.z)
  ctx.clearRect(0, 0, size, size)
  for (const dot of dots) {
    ctx.beginPath()
    ctx.arc(dot.x, dot.y, Math.max(0.6, dot.r), 0, Math.PI * 2)
    ctx.fillStyle = dot.isHighlight ? (dot.alpha > 0.8 ? '#ffffff' : colors.accent) : colors.violet
    ctx.globalAlpha = Math.min(1, dot.alpha * (dot.isHighlight ? 1 : 0.75))
    ctx.fill()
  }
  ctx.globalAlpha = 1
  painted = true
  return true
}

function stopLoop(): void {
  if (rafId !== null) cancelAnimationFrame(rafId)
  rafId = null
  previousTime = null
}

function frame(now: number): void {
  rafId = null
  if (!canAnimate.value || props.paused || resolvedSpeed.value === 0) return
  if (previousTime !== null) animationTime += Math.min(64, Math.max(0, now - previousTime)) * resolvedSpeed.value
  previousTime = now
  if (drawFrame(animationTime)) rafId = requestAnimationFrame(frame)
}

function reconcile(): void {
  stopLoop()
  if (!canPresent.value) return
  if (!painted || reducedMotion.value) drawFrame(reducedMotion.value ? 1500 : animationTime)
  if (canAnimate.value && !props.paused && resolvedSpeed.value > 0) rafId = requestAnimationFrame(frame)
}

watch([canPresent, canAnimate, () => props.paused, resolvedSpeed], reconcile, { flush: 'post' })
watch([resolvedPixelSize, () => props.state, () => props.colorVariant, appearanceRevision], () => {
  initCanvas()
  readColors()
  if (canPresent.value) drawFrame(reducedMotion.value ? 1500 : animationTime)
  reconcile()
}, { flush: 'post' })

onMounted(() => {
  initCanvas()
  readColors()
  reconcile()
})
onBeforeUnmount(stopLoop)
</script>

<style scoped>
.thinking-orb-host {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  vertical-align: middle;
  position: relative;
  line-height: 0;
  user-select: none;
}
.thinking-orb-canvas {
  display: block;
  pointer-events: none;
  filter: drop-shadow(0 0 10px var(--accent-glow, rgba(242, 168, 190, 0.4)));
}
.size-sm .thinking-orb-canvas {
  filter: drop-shadow(0 0 4px var(--accent-glow, rgba(242, 168, 190, 0.3)));
}
.is-low-effects .thinking-orb-canvas { filter: none; }
</style>
