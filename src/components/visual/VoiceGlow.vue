<template>
  <div
    ref="containerRef"
    class="voice-glow-container"
    :class="{
      'is-active': active,
      'is-processing': processing,
      [`variant-${colorVariant}`]: true,
    }"
    aria-hidden="true"
  >
    <canvas
      ref="canvasRef"
      class="voice-glow-canvas"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'

const props = withDefaults(
  defineProps<{
    /** 是否激活声控光晕 */
    active?: boolean
    /** 音频电平 (0~1)，由外部麦克风或音量分析器传入 */
    level?: number
    /** 语音识别/思考中的流光状态 (光带在底部左右游走) */
    processing?: boolean
    /** 呼吸周期 (秒) */
    breatheDuration?: number
    /** 升起最大高度 (px) */
    maxHeight?: number
    /** 色彩变体：dual (甜系粉紫) | accent (粉) | violet (紫) */
    colorVariant?: 'dual' | 'accent' | 'violet'
    /** 静默状态下的呼吸微光强度 (0~1) */
    idleStrength?: number
  }>(),
  {
    active: true,
    level: 0,
    processing: false,
    breatheDuration: 4.6,
    maxHeight: 28,
    colorVariant: 'dual',
    idleStrength: 0.22,
  }
)

const containerRef = ref<HTMLElement | null>(null)
const canvasRef = ref<HTMLCanvasElement | null>(null)

let rafId: number | null = null
let smoothedLevel = 0
let lastTime = 0
let resizeObserver: ResizeObserver | null = null
let isReducedMotion = false

function checkReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function parseColors(): { primary: string; secondary: string } {
  if (typeof window === 'undefined' || !containerRef.value) {
    return { primary: '#F2A8BE', secondary: '#B784F6' }
  }
  const styles = getComputedStyle(containerRef.value)
  const accent = styles.getPropertyValue('--accent').trim() || '#F2A8BE'
  const violet = styles.getPropertyValue('--accent-violet').trim() || '#B784F6'

  switch (props.colorVariant) {
    case 'accent':
      return { primary: accent, secondary: accent }
    case 'violet':
      return { primary: violet, secondary: violet }
    case 'dual':
    default:
      return { primary: accent, secondary: violet }
  }
}

function updateCanvasSize(): void {
  const canvas = canvasRef.value
  const container = containerRef.value
  if (!canvas || !container) return

  const rect = container.getBoundingClientRect()
  const w = Math.round(rect.width) || 320
  const h = props.maxHeight

  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  canvas.width = Math.round(w * dpr)
  canvas.height = Math.round(h * dpr)
  canvas.style.width = `${w}px`
  canvas.style.height = `${h}px`
}

// 核心物理阻尼包络跟踪 (One-pole filter)
function updateEnvelope(targetLevel: number, dt: number): number {
  const attack = 0.12 // 上升快 (120ms)
  const release = 0.45 // 下降平滑 (450ms)
  const tau = targetLevel > smoothedLevel ? attack : release
  const alpha = 1 - Math.exp(-dt / tau)
  smoothedLevel += (targetLevel - smoothedLevel) * alpha
  return smoothedLevel
}

function renderFrame(now: number): void {
  if (!props.active || !canvasRef.value) {
    stopAnimation()
    return
  }

  const canvas = canvasRef.value
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  if (!lastTime) lastTime = now
  const dt = Math.min((now - lastTime) / 1000, 0.1)
  lastTime = now

  const target = Math.max(0, Math.min(1, props.level))
  const currentLevel = updateEnvelope(target, dt)

  // 呼吸态计算：无声音时维持微弱的慢正弦呼吸
  const breathe = isReducedMotion
    ? 0.5
    : 0.5 + 0.5 * Math.sin((2 * Math.PI * (now / 1000)) / props.breatheDuration)
  const idleFactor = (1 - currentLevel) * props.idleStrength * breathe
  const effectiveLevel = Math.max(currentLevel, idleFactor)

  const w = canvas.width
  const h = canvas.height
  ctx.clearRect(0, 0, w, h)

  if (effectiveLevel <= 0.01) {
    rafId = requestAnimationFrame(renderFrame)
    return
  }

  const { primary, secondary } = parseColors()

  // 处理态光斑中心左右游走：[-0.3w, 0.3w]
  let centerX = w * 0.5
  if (props.processing && !isReducedMotion) {
    const sweep = Math.sin((now / 1000) * 2.8) * 0.32
    centerX = w * (0.5 + sweep)
  }

  // 1. 绘制升起的柔光渐变 (Inner Light)
  const riseHeight = h * (0.35 + 0.65 * effectiveLevel)
  const gradient = ctx.createLinearGradient(centerX, h, centerX, h - riseHeight)
  gradient.addColorStop(0, primary)
  gradient.addColorStop(0.5, secondary)
  gradient.addColorStop(1, 'transparent')

  ctx.save()
  ctx.fillStyle = gradient
  ctx.globalAlpha = Math.min(1, 0.35 + 0.65 * effectiveLevel)

  // 2. 钟形曲线计算 (Gaussian Bell Curve)
  ctx.beginPath()
  ctx.moveTo(0, h)

  const steps = 60
  const curvePower = 1.8
  const bellSpread = w * (0.35 + 0.25 * effectiveLevel)

  for (let i = 0; i <= steps; i++) {
    const x = (i / steps) * w
    const dist = Math.abs(x - centerX)
    const normalizedDist = dist / (bellSpread * 0.5)
    const bell = Math.exp(-Math.pow(normalizedDist, curvePower))
    const y = h - bell * riseHeight
    ctx.lineTo(x, y)
  }

  ctx.lineTo(w, h)
  ctx.closePath()
  ctx.fill()

  // 3. 绘制顶部边缘微光高光弧线 (Band Stroke)
  ctx.beginPath()
  for (let i = 0; i <= steps; i++) {
    const x = (i / steps) * w
    const dist = Math.abs(x - centerX)
    const normalizedDist = dist / (bellSpread * 0.5)
    const bell = Math.exp(-Math.pow(normalizedDist, curvePower))
    const y = h - bell * riseHeight
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }

  ctx.strokeStyle = '#ffffff'
  ctx.lineWidth = Math.max(1, 1.5 * effectiveLevel)
  ctx.globalAlpha = Math.min(1, 0.2 + 0.7 * effectiveLevel)
  ctx.stroke()

  ctx.restore()

  rafId = requestAnimationFrame(renderFrame)
}

function startAnimation(): void {
  if (rafId === null && props.active) {
    lastTime = 0
    rafId = requestAnimationFrame(renderFrame)
  }
}

function stopAnimation(): void {
  if (rafId !== null) {
    cancelAnimationFrame(rafId)
    rafId = null
  }
}

watch(
  () => props.active,
  (val) => {
    if (val) startAnimation()
    else stopAnimation()
  }
)

onMounted(() => {
  isReducedMotion = checkReducedMotion()
  updateCanvasSize()

  if (containerRef.value && typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => {
      updateCanvasSize()
    })
    resizeObserver.observe(containerRef.value)
  }

  if (props.active) {
    startAnimation()
  }
})

onBeforeUnmount(() => {
  stopAnimation()
  if (resizeObserver) {
    resizeObserver.disconnect()
    resizeObserver = null
  }
})
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
}

.voice-glow-canvas {
  display: block;
  width: 100%;
  pointer-events: none;
  filter: drop-shadow(0 -2px 8px var(--accent-glow, rgba(242, 168, 190, 0.35)));
}

@media (prefers-reduced-motion: reduce) {
  .voice-glow-canvas {
    filter: none !important;
  }
}
</style>
