<template>
  <div
    ref="containerRef"
    class="thinking-orb-host"
    :class="{
      [`size-${typeof size === 'string' ? size : 'custom'}`]: true,
      'is-paused': paused || !isVisible,
    }"
    role="status"
    :aria-label="ariaLabel || stateLabel"
  >
    <canvas
      ref="canvasRef"
      class="thinking-orb-canvas"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'

export type OrbState = 'working' | 'weaving' | 'searching'

const props = withDefaults(
  defineProps<{
    /** 状态：working (粒子轨道) | weaving (三线编织) | searching (扫描经纬网) */
    state?: OrbState
    /** 尺寸：sm (20px) | md (48px) | lg (64px) 或自定义像素数 */
    size?: 'sm' | 'md' | 'lg' | number
    /** 速度倍率 */
    speed?: number
    /** 是否暂停在当前帧 */
    paused?: boolean
    /** 覆盖默认无障碍文本 */
    ariaLabel?: string
    /** 色彩变体：dual (粉紫双色) | accent (樱花粉) | violet (薰衣草紫) */
    colorVariant?: 'dual' | 'accent' | 'violet'
  }>(),
  {
    state: 'working',
    size: 'md',
    speed: 1,
    paused: false,
    colorVariant: 'dual',
  }
)

const containerRef = ref<HTMLElement | null>(null)
const canvasRef = ref<HTMLCanvasElement | null>(null)

const isVisible = ref(true)
let rafId: number | null = null
let intersectionObserver: IntersectionObserver | null = null
let isReducedMotion = false

const resolvedPixelSize = computed(() => {
  if (typeof props.size === 'number') return Math.max(16, props.size)
  switch (props.size) {
    case 'sm':
      return 20
    case 'lg':
      return 64
    case 'md':
    default:
      return 48
  }
})

const stateLabel = computed(() => {
  switch (props.state) {
    case 'weaving':
      return '正在编织画面意境…'
    case 'searching':
      return '正在检索匹配场景…'
    case 'working':
    default:
      return '心动画面显影生成中…'
  }
})

function checkReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function parseColors(): { accent: string; violet: string } {
  if (typeof window === 'undefined' || !containerRef.value) {
    return { accent: '#F2A8BE', violet: '#B784F6' }
  }
  const styles = getComputedStyle(containerRef.value)
  const accent = styles.getPropertyValue('--accent').trim() || '#F2A8BE'
  const violet = styles.getPropertyValue('--accent-violet').trim() || '#B784F6'

  switch (props.colorVariant) {
    case 'accent':
      return { accent, violet: accent }
    case 'violet':
      return { accent: violet, violet }
    case 'dual':
    default:
      return { accent, violet }
  }
}

function initCanvas(): void {
  const canvas = canvasRef.value
  if (!canvas) return
  const s = resolvedPixelSize.value
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  canvas.width = Math.round(s * dpr)
  canvas.height = Math.round(s * dpr)
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

// 三维到二维投影与旋转
function project3D(
  x: number,
  y: number,
  z: number,
  pitch: number,
  yaw: number,
  cx: number,
  cy: number
): [number, number, number] {
  const cosY = Math.cos(yaw)
  const sinY = Math.sin(yaw)
  const x1 = x * cosY - z * sinY
  const z1 = x * sinY + z * cosY

  const cosP = Math.cos(pitch)
  const sinP = Math.sin(pitch)
  const y2 = y * cosP - z1 * sinP
  const z2 = y * sinP + z1 * cosP

  return [cx + x1, cy + y2, z2]
}

function renderFrame(timeMs: number): void {
  if (!canvasRef.value || props.paused || !isVisible.value) {
    return
  }

  const canvas = canvasRef.value
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const size = resolvedPixelSize.value * dpr
  const cx = size / 2
  const cy = size / 2
  const R = size * 0.42

  const t = isReducedMotion ? 1.5 : (timeMs / 1000) * props.speed
  const dots: ParticleDot[] = []

  if (props.state === 'weaving') {
    // 状态 A：斐波那契螺旋三线编织 (Braid)
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
        const [px, py, pz] = project3D(
          Math.cos(angle) * rr,
          u * R * weave,
          Math.sin(angle) * rr,
          0.35,
          t * 0.4,
          cx,
          cy
        )
        const depth = (pz / R + 1) / 2
        dots.push({
          x: px,
          y: py,
          z: pz,
          r: (1.1 + 1.2 * depth) * (size / 64),
          alpha: 0.25 + 0.75 * depth,
          isHighlight: depth > 0.75,
        })
      }
    }
  } else if (props.state === 'searching') {
    // 状态 B：经纬网扫描雷达球 (Searching)
    const meridians = resolvedPixelSize.value < 30 ? 4 : 8
    const pointsPerMeridian = resolvedPixelSize.value < 30 ? 16 : 28
    const scanAngle = (t * 2.2) % (Math.PI * 2)

    for (let m = 0; m < meridians; m++) {
      const phi = (m / meridians) * Math.PI
      for (let p = 0; p < pointsPerMeridian; p++) {
        const theta = (p / pointsPerMeridian) * Math.PI * 2
        const x = R * Math.sin(phi) * Math.cos(theta)
        const y = R * Math.cos(phi)
        const z = R * Math.sin(phi) * Math.sin(theta)
        const [px, py, pz] = project3D(x, y, z, 0.4, t * 0.2, cx, cy)
        const depth = (pz / R + 1) / 2
        const angleDiff = Math.abs((theta - scanAngle + Math.PI * 4) % (Math.PI * 2) - Math.PI)
        const scanHighlight = Math.max(0, 1 - angleDiff / 0.8)

        dots.push({
          x: px,
          y: py,
          z: pz,
          r: (0.9 + scanHighlight * 1.4) * (size / 64),
          alpha: (0.15 + 0.35 * depth) + scanHighlight * 0.5,
          isHighlight: scanHighlight > 0.4,
        })
      }
    }
  } else {
    // 状态 C（默认）：倾斜粒子轨道星系 (Orbits - working)
    const orbitCount = resolvedPixelSize.value < 30 ? 4 : 8
    const ghostDotsPerOrbit = resolvedPixelSize.value < 30 ? 18 : 32

    for (let o = 0; o < orbitCount; o++) {
      const ro = R * (0.45 + 0.52 * ((o * 1.618) % 1))
      const tiltX = (o * 0.7) % Math.PI
      const tiltY = (o * 1.2) % Math.PI
      const orbitSpeed = (0.4 + 0.5 * ((o * 2.1) % 1)) * (o % 2 === 0 ? 1 : -1)

      // 幽灵暗轨 (Ghost path)
      for (let k = 0; k < ghostDotsPerOrbit; k++) {
        const a = (k / ghostDotsPerOrbit) * Math.PI * 2
        const [px, py, pz] = project3D(
          Math.cos(a) * ro,
          Math.sin(a) * ro * Math.sin(tiltX),
          Math.sin(a) * ro * Math.cos(tiltY),
          0.3,
          t * 0.15,
          cx,
          cy
        )
        const depth = (pz / ro + 1) / 2
        dots.push({
          x: px,
          y: py,
          z: pz,
          r: 0.8 * (size / 64),
          alpha: 0.12 + 0.28 * depth,
          isHighlight: false,
        })
      }

      // 飞驰的激活粒子 (Running particles)
      const particleA = t * orbitSpeed + (o * Math.PI) / 2
      const [px, py, pz] = project3D(
        Math.cos(particleA) * ro,
        Math.sin(particleA) * ro * Math.sin(tiltX),
        Math.sin(particleA) * ro * Math.cos(tiltY),
        0.3,
        t * 0.15,
        cx,
        cy
      )
      const depth = (pz / ro + 1) / 2
      dots.push({
        x: px,
        y: py,
        z: pz,
        r: (1.5 + 1.6 * depth) * (size / 64),
        alpha: 0.6 + 0.4 * depth,
        isHighlight: true,
      })
    }
  }

  // 按 z 轴深度排序，确保真实前后遮挡
  dots.sort((a, b) => a.z - b.z)

  ctx.clearRect(0, 0, size, size)
  const { accent, violet } = parseColors()

  // 绘制粒子
  for (let i = 0; i < dots.length; i++) {
    const dot = dots[i]
    ctx.beginPath()
    ctx.arc(dot.x, dot.y, Math.max(0.6, dot.r), 0, Math.PI * 2)

    if (dot.isHighlight) {
      ctx.fillStyle = dot.alpha > 0.8 ? '#ffffff' : accent
      ctx.globalAlpha = Math.min(1, dot.alpha)
    } else {
      ctx.fillStyle = violet
      ctx.globalAlpha = Math.min(1, dot.alpha * 0.75)
    }
    ctx.fill()
  }

  ctx.globalAlpha = 1

  if (!isReducedMotion && !props.paused && isVisible.value) {
    rafId = requestAnimationFrame(renderFrame)
  }
}

function startLoop(): void {
  if (rafId === null && isVisible.value && !props.paused) {
    rafId = requestAnimationFrame(renderFrame)
  }
}

function stopLoop(): void {
  if (rafId !== null) {
    cancelAnimationFrame(rafId)
    rafId = null
  }
}

watch(
  () => [props.state, props.size, props.speed, props.paused, isVisible.value],
  () => {
    initCanvas()
    stopLoop()
    if (!props.paused && isVisible.value) {
      startLoop()
    } else if (isReducedMotion || props.paused) {
      // 保持单帧静态渲染
      renderFrame(1000)
    }
  }
)

onMounted(() => {
  isReducedMotion = checkReducedMotion()
  initCanvas()

  // 离屏自动休眠
  if (containerRef.value && typeof IntersectionObserver !== 'undefined') {
    intersectionObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          isVisible.value = entry.isIntersecting
          if (entry.isIntersecting) {
            startLoop()
          } else {
            stopLoop()
          }
        }
      },
      { rootMargin: '128px' }
    )
    intersectionObserver.observe(containerRef.value)
  }

  // 标签页切换休眠
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        stopLoop()
      } else if (isVisible.value) {
        startLoop()
      }
    })
  }

  startLoop()
})

onBeforeUnmount(() => {
  stopLoop()
  if (intersectionObserver) {
    intersectionObserver.disconnect()
    intersectionObserver = null
  }
})
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

@media (prefers-reduced-motion: reduce) {
  .thinking-orb-canvas {
    filter: none !important;
  }
}
</style>
