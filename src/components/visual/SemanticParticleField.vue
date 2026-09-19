<template>
  <figure
    ref="host"
    class="semantic-particle-field"
    :class="[`density-${density}`, `signal-${signal}`, { 'is-static': reduceMotion, 'has-canvas': canvasAvailable, 'is-bare': bare, 'has-portrait': portraitActive }]"
    :role="decorative ? undefined : 'img'"
    :aria-label="decorative ? undefined : label"
    :aria-hidden="decorative ? 'true' : undefined"
    @pointermove="onPointerMove"
    @pointerleave="onPointerLeave"
  >
    <canvas ref="canvas" aria-hidden="true"></canvas>
    <div class="particle-fallback" aria-hidden="true">
      <span v-for="index in 18" :key="index" :style="{ '--fallback-index': String(index) }"></span>
    </div>
    <figcaption v-if="caption" class="particle-caption">{{ caption }}</figcaption>
  </figure>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { createParticleShape, type ParticlePoint, type ParticleShapeId } from '@/utils/particleShapes'
import { loadPortraitCloud, samplePortraitPoints, particleNeedsOutline, type PortraitCloud } from '@/utils/particlePortrait'
import { registerParticleFrame } from '@/utils/particleScheduler'
import { useParticlePerformanceLifecycle } from '@/composables/useParticlePerformanceLifecycle'

const props = withDefaults(defineProps<{
  shape: ParticleShapeId
  label: string
  caption?: string
  density?: 'backdrop' | 'ambient' | 'hero'
  interactive?: boolean
  bare?: boolean
  decorative?: boolean
  signal?: 'idle' | 'active' | 'success' | 'warning'
  /** 角色形象粒子：提供且有预生成点云时，粒子重组为该角色的剪影（缺省回落 shape）。 */
  portraitId?: string
}>(), {
  caption: '',
  density: 'hero',
  interactive: true,
  bare: false,
  decorative: false,
  signal: 'idle',
  portraitId: '',
})

interface RuntimeParticle {
  x: number
  y: number
  /** 上一帧位置：运动拖尾线段（对齐参考实现的残影流光；静止时无拖尾）。 */
  prevX: number
  prevY: number
  velocityX: number
  velocityY: number
  targetX: number
  targetY: number
  tone: 0 | 1 | 2
  paint: number
  phase: number
  depth: number
  size: number
}

interface Palette {
  primary: string
  secondary: string
  accent: string
}

const host = ref<HTMLElement | null>(null)
const canvas = ref<HTMLCanvasElement | null>(null)
const canvasAvailable = ref(true)
/** 深色主题下图片点阵用 screen 混合：暗部自然隐入页面底色、亮部发光，
    消除"贴上去的彩色马赛克"突兀感（2026-08-16 用户反馈）。 */
let darkTheme = true
let particleSurface = '#f0edf4'
let particleOutline = '#3c3548'

/** 角色形象点云：null = 用抽象形状。异步加载由 token 防竞态。 */
let portraitCloud: PortraitCloud | null = null
/** 剪影调色板（深色已提亮——深色主题暗部 screen 下不可见，提亮保证可读），与 portraitCloud 同步更新。 */
let portraitPaints: string[] = []
/** 原始调色板（未提亮）：浅色主题直接用原图颜色（暗部在浅底上天然清晰），
    颜色与深色主题一致还原原图（2026-08-16 用户反馈「浅色模式颜色不对」）。 */
let portraitRaw: string[] = []
/** 半调点阵：每个调色板色的网点半径（剪影模式统一点径，见 setShape）。 */
let portraitRadii: number[] = []
let portraitToken = 0
/** 图片点阵激活标记（模板用，隐藏画布中央的装饰菱形标记）。 */
const portraitActive = ref(false)

/** 逸散/浮动粒子（优化点 ③）：缓慢漂移、闪烁淡出的发光碎屑，打破纯静态点阵
    的呆板感；hero/ambient 密度启用，backdrop 不启用（保持省电与静止背景）。 */
interface AmbientParticle {
  x: number
  y: number
  vx: number
  vy: number
  phase: number
  size: number
  paint: number
}
let ambient: AmbientParticle[] = []

/** 主题可读性：人物原色可能过暗（黑裙/深发在深色主题不可见），提亮到最低亮度。 */
function legibleColor(hex: string): string {
  const value = hex.trim()
  const match = /^#?([0-9a-f]{6})$/i.exec(value)
  if (!match) return value
  const full = match[1]
  let r = parseInt(full.slice(0, 2), 16) / 255
  let g = parseInt(full.slice(2, 4), 16) / 255
  let b = parseInt(full.slice(4, 6), 16) / 255
  const MIN = 0.34
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
  if (lum < MIN) {
    const lift = (MIN - lum) / Math.max(1e-6, 1 - lum)
    r += (1 - r) * lift
    g += (1 - g) * lift
    b += (1 - b) * lift
  }
  const to255 = (c: number) => Math.round(Math.min(1, Math.max(0, c)) * 255)
  return `#${[to255(r), to255(g), to255(b)].map(v => v.toString(16).padStart(2, '0')).join('')}`
}

let context: CanvasRenderingContext2D | null = null
let resizeObserver: ResizeObserver | null = null
let intersectionObserver: IntersectionObserver | null = null
let themeObserver: MutationObserver | null = null
let motionMedia: MediaQueryList | null = null
let stopScheduledFrame: (() => void) | null = null
let paletteFrame = 0
let width = 0
let height = 0
let dpr = 1
let particles: RuntimeParticle[] = []
let palette: Palette = { primary: '#d9d5df', secondary: '#77717f', accent: '#ff8fc4' }
let visible = true
let pointerX = -10000
let pointerY = -10000
let pointerActive = false
let lastFrame = 0
let lastPhysicsFrame = 0
let lastAmbientFrame = 0
let slowFrames = 0
let qualityScale = 1
const performance = useParticlePerformanceLifecycle({
  rebuild: () => setShape(false), start: startLoop, stop: stopLoop, resize,
  cancelDeferred: () => { if (paletteFrame) { cancelAnimationFrame(paletteFrame); paletteFrame = 0 } },
  paletteChanged: schedulePaletteRead,
  visible: () => visible,
})
const { lowEffects, reduceMotion } = performance

function preferredCount(): number {
  if (reduceMotion.value) return 420
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory
  // 760 → 768：对齐断点表的 --bp-sm。档外值会让 760–768 这 8px 区间单独跳一次，
  // 调试时极难看出是哪条规则生效（2026-08-30 UX 审计 P2）
  const compact = window.matchMedia('(max-width: 768px)').matches
  let count: number
  if (props.density === 'backdrop') count = compact ? 220 : 380
  else if (compact || (memory !== undefined && memory <= 4)) count = 520
  else count = props.density === 'ambient' ? 780 : 1380
  // 图片点阵密度：整图复刻需要更高点数承载细节（32 色层次 + 背景成像）；
  // hero 8000 / ambient 6000 / 窄屏 2400，点径 0.55×点距留出点阵缝隙感。
  // 物理与绘制均为 O(n) 批处理，慢帧自愈降档继续兜底。
  if (portraitCloud) {
    count = Math.max(count, compact ? 2400 : props.density === 'hero' ? 8000 : 6000)
  }
  return Math.round(count * qualityScale * (lowEffects.value ? 0.65 : 1))
}

function readPalette() {
  if (!host.value) return
  darkTheme = (document.documentElement.dataset.theme || 'dark') !== 'light'
  const style = getComputedStyle(host.value)
  particleSurface = style.getPropertyValue('--particle-surface').trim() || '#f0edf4'
  particleOutline = style.getPropertyValue('--particle-outline').trim() || '#3c3548'
  palette = {
    primary: style.getPropertyValue('--text-primary').trim() || '#d9d5df',
    secondary: style.getPropertyValue('--text-muted').trim() || '#77717f',
    accent: style.getPropertyValue('--particle-accent').trim() || style.getPropertyValue('--accent').trim() || '#ff8fc4',
  }
  draw()
}

/**
 * 主题切换时所有粒子场会同时触发 MutationObserver。
 * 直接同步 readPalette 会在切换瞬间做 N 次 getComputedStyle（强制 reflow），
 * 这正是深色/浅色切换卡顿的来源之一：合并到下一帧批量执行一次。
 */
function schedulePaletteRead() {
  if (!performance.active.value || paletteFrame) return
  paletteFrame = requestAnimationFrame(() => {
    paletteFrame = 0
    readPalette()
  })
}

function targetPosition(point: ParticlePoint): { x: number; y: number } {
  // 剪影模式边距收窄（4%）：配合点云内容盒 1.02，人物实际占屏约 94%，
  // 消除「人物显小、留白过多」；抽象形状维持 8% 经典边距。
  const paddingX = portraitCloud ? Math.max(10, width * 0.04) : Math.max(22, width * 0.08)
  const paddingY = portraitCloud ? Math.max(10, height * 0.04) : Math.max(20, height * 0.08)
  return {
    x: paddingX + point.x * Math.max(1, width - paddingX * 2),
    y: paddingY + point.y * Math.max(1, height - paddingY * 2),
  }
}

function setShape(animate = true) {
  if (!width || !height) return
  const count = Math.max(props.density === 'backdrop' ? 80 : 120, preferredCount())
  let shape: ParticlePoint[]
  if (portraitCloud) {
    const sample = samplePortraitPoints(portraitCloud, count, width, height)
    shape = sample.points
    // 统一点径 = 0.3×点距（2026-08-16 对齐参考实现 CONFIG.particleSize=3 /
    // samplingStep=5 ≈ 0.3×间距）：点与点之间保留清晰负空间，还原点阵网格
    // 空气感；此前 0.55× 点径让网点粘连成「位图」，失掉离散点阵质感。
    portraitRadii = portraitPaints.map(() => sample.spacing * 0.3)
  } else {
    shape = createParticleShape(props.shape, count)
  }
  if (!shape.length) return
  const previous = particles.slice().sort((a, b) => {
    const rowA = Math.round(a.y / Math.max(1, height) * 18)
    const rowB = Math.round(b.y / Math.max(1, height) * 18)
    return rowA === rowB ? a.x - b.x : rowA - rowB
  })

  particles = shape.map((point, index) => {
    const target = targetPosition(point)
    const current = previous[index]
    const x = current?.x ?? (animate ? Math.random() * width : target.x)
    const y = current?.y ?? (animate ? Math.random() * height : target.y)
    return {
      x,
      y,
      prevX: current?.prevX ?? x,
      prevY: current?.prevY ?? y,
      velocityX: current?.velocityX ?? 0,
      velocityY: current?.velocityY ?? 0,
      targetX: target.x,
      targetY: target.y,
      tone: point.tone,
      paint: point.paint ?? point.tone,
      phase: current?.phase ?? Math.random() * Math.PI * 2,
      depth: current?.depth ?? 0.55 + Math.random() * 0.45,
      // 剪影模式粒子尺寸恒定（参考实现 particleSize 恒定，无抖动）：
      // 点阵更均匀，成像更「实」；抽象形状保留尺寸层次。
      size: current?.size ?? (portraitCloud ? 1 : 0.88 + Math.random() * 0.24),
    }
  })

  if (!animate || reduceMotion.value) {
    particles.forEach((particle) => {
      particle.x = particle.targetX
      particle.y = particle.targetY
      particle.velocityX = 0
      particle.velocityY = 0
    })
    draw()
  } else {
    startLoop()
  }
  ensureAmbient()
}

/**
 * 逸散粒子：hero/ambient 密度各 40/24 颗，随机方向缓慢漂移 + 正弦闪烁；
 * backdrop 与 reduced-motion 不启用（保持静止背景与省电）。
 */
function ensureAmbient() {
  if (reduceMotion.value || props.density === 'backdrop' || !width || !height) {
    ambient = []
    return
  }
  const target = props.density === 'hero' ? 40 : 24
  const paints = portraitCloud && portraitPaints.length ? portraitPaints : null
  while (ambient.length < target) {
    const angle = Math.random() * Math.PI * 2
    const speed = 0.06 + Math.random() * 0.16
    ambient.push({
      x: Math.random() * width,
      y: Math.random() * height,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      phase: Math.random() * Math.PI * 2,
      size: 0.7 + Math.random() * 1.1,
      paint: paints ? Math.floor(Math.random() * paints.length) : (Math.random() < 0.25 ? 2 : 0),
    })
  }
}

function updateAmbient(step: number) {
  const margin = 24
  for (const dot of ambient) {
    dot.x += dot.vx * step
    dot.y += dot.vy * step
    dot.phase += 0.035 * step
    if (dot.x < -margin || dot.x > width + margin || dot.y < -margin || dot.y > height + margin) {
      dot.x = Math.random() * width
      dot.y = Math.random() * height
      const angle = Math.random() * Math.PI * 2
      const speed = 0.06 + Math.random() * 0.16
      dot.vx = Math.cos(angle) * speed
      dot.vy = Math.sin(angle) * speed
    }
  }
}

/**
 * 物理模型逐项对标 Arknights-FlowingPoints 的 CONFIG（2026-08-16 起全站统一，
 * 不再区分剪影/抽象形状）：斥力半径 105px 固定、平方衰减力 1.8、恒定回位
 * 弹簧 0.01（慢回流=流动感）、摩擦 0.15/帧；无待机漂移、无点击脉冲、无指针
 * 高光——参考实现均没有这些。step 按帧时长归一（高刷屏不变速）。
 */
function simulateParticles(now: number): boolean {
  const elapsed = lastPhysicsFrame ? Math.min(32, Math.max(1, now - lastPhysicsFrame)) : 16.67
  const step = elapsed / 16.67
  const interactionRadius = 105
  const interactionRadiusSquared = interactionRadius * interactionRadius
  let moving = pointerActive

  for (const particle of particles) {
    particle.prevX = particle.x
    particle.prevY = particle.y
    particle.velocityX += (particle.targetX - particle.x) * 0.01 * step
    particle.velocityY += (particle.targetY - particle.y) * 0.01 * step

    if (props.interactive && pointerActive) {
      const dx = particle.x - pointerX
      const dy = particle.y - pointerY
      const distanceSquared = dx * dx + dy * dy
      if (distanceSquared < interactionRadiusSquared) {
        const distance = Math.sqrt(distanceSquared)
        const directionX = distance > 0.1 ? dx / distance : Math.cos(particle.phase)
        const directionY = distance > 0.1 ? dy / distance : Math.sin(particle.phase)
        const force = (1 - distance / interactionRadius) ** 2 * 1.8
        particle.velocityX += directionX * force * step
        particle.velocityY += directionY * force * step
      }
    }

    const damping = Math.pow(0.85, step)
    particle.velocityX *= damping
    particle.velocityY *= damping
    particle.x += particle.velocityX * step
    particle.y += particle.velocityY * step

    if (Math.abs(particle.velocityX) > 0.012 || Math.abs(particle.velocityY) > 0.012
      || Math.abs(particle.targetX - particle.x) > 0.12 || Math.abs(particle.targetY - particle.y) > 0.12) {
      moving = true
    }
  }

  lastPhysicsFrame = now
  return moving
}

function draw() {
  if (!context || !canvas.value) return
  const ctx = context
  ctx.clearRect(0, 0, width, height)
  // 剪影模式按人物调色板分批填充 + 统一点径；抽象形状沿用三档 tone
  // 颜色与三档点径（页面识别色 + 层次感）。动效全站统一：静止成像、
  // 无漂移、无指针高光、慢回流物理。
  // 绘制调色板：深色主题用提亮版（暗部 screen 下不可见，提亮保证可读）；
  // 浅色主题用原始色（暗部在浅底上天然清晰，颜色还原原图——2026-08-16
  // 用户反馈「浅色模式颜色不对」后改为原始色）。
  const paints = portraitCloud && portraitPaints.length
    ? (darkTheme ? portraitPaints : (portraitRaw.length ? portraitRaw : portraitPaints))
    : null
  const paths = paints
    ? paints.map(() => new Path2D())
    : [new Path2D(), new Path2D(), new Path2D()]
  // 运动拖尾（对齐参考实现的残影流光）：粒子位移超过阈值时连一条
  // 上一帧→当前帧线段；静止粒子不入路径——空闲观感不变，交互涟漪带出流光。
  const tailPaths = paths.map(() => new Path2D())
  // Light-mode points retain their original colors. A thin concentric ink edge
  // separates low-contrast colors from the paper surface without darkening their centers.
  const shadowFlags = paints && !darkTheme ? paints.map(color => particleNeedsOutline(color, particleSurface)) : null
  const shadowPaths = shadowFlags?.some(Boolean) ? shadowFlags.map(outline => outline ? new Path2D() : null) : null
  const underColor = particleOutline
  const energyScale = props.signal === 'active' ? 1.16 : props.signal === 'warning' ? 1.08 : 1

  for (const particle of particles) {
    const pathIndex = paints
      ? Math.min(paths.length - 1, Math.max(0, particle.paint))
      : particle.tone
    const path = paths[pathIndex]
    // 图片点阵（剪影/整图复刻）统一点径；抽象形状维持经典三档点径
    // （0.78/1.05/1.55 的层次 + 强调色亮点——2026-08-16 用户决策恢复，
    // 统一大点径在稀疏轮廓形状上显得粗笨）
    const baseRadius = paints
      ? (portraitRadii[pathIndex] || 1)
      : particle.tone === 2 ? 1.55 : particle.tone === 1 ? 1.05 : 0.78
    const radius = baseRadius * (paints && !darkTheme ? 1.35 : 1) * energyScale * particle.size
    const dx = particle.x - particle.prevX
    const dy = particle.y - particle.prevY
    if (dx * dx + dy * dy > 0.12) {
      tailPaths[pathIndex].moveTo(particle.prevX, particle.prevY)
      tailPaths[pathIndex].lineTo(particle.x, particle.y)
    }
    if (shadowPaths) {
      const shadow = shadowPaths[pathIndex]
      if (shadow) {
        // 阴影圆：右下偏移 0.5px、半径 ×1.15（比点本体略大，露一圈阴影边）
        shadow.moveTo(particle.x + radius * 1.12, particle.y)
        shadow.arc(particle.x, particle.y, radius * 1.12, 0, Math.PI * 2)
      }
    }
    path.moveTo(particle.x + radius, particle.y)
    path.arc(particle.x, particle.y, radius, 0, Math.PI * 2)
  }
  // 先拖尾后头点：流光在点后，头点保持锐利；混合模式跟随主体（深色 screen 发光）。
  ctx.lineCap = 'round'
  if (paints) {
    ctx.globalCompositeOperation = darkTheme ? 'screen' : 'source-over'
    // 极亮色阴影圆：先画阴影后主点（阴影在点下方，露出右下弧边界定）。
    // 深色主题 screen 下近黑阴影≈不可见，无副作用。
    // alpha 0.42：0.5 实测阴影圆偏重、密集白发区显脏（干净度降）。
    if (shadowPaths) {
      ctx.globalCompositeOperation = 'source-over'
      ctx.globalAlpha = .88
      ctx.fillStyle = underColor
      shadowPaths.forEach((path) => { if (path) ctx.fill(path) })
      ctx.globalCompositeOperation = darkTheme ? 'screen' : 'source-over'
    }
    // 浅色主题拖尾先垫深色衬线：亮色流光在浅底上同样会「隐形」，交互时
    // 涟漪残影要保持可见；深色主题 screen 下亮色自带发光，无需衬线。
    if (!darkTheme) {
      ctx.globalAlpha = .3
      ctx.strokeStyle = underColor
      ctx.lineWidth = 2.4
      tailPaths.forEach((path) => ctx.stroke(path))
    }
    paints.forEach((color, index) => {
      ctx.globalAlpha = .32
      ctx.strokeStyle = color
      ctx.lineWidth = 1.4
      ctx.stroke(tailPaths[index])
    })
    // 图片点阵：深色主题 screen 混合（暗部隐入底色、亮部发光，与档案风融合）；
    // 浅色主题正常混合、主点透明度 0.95（几乎不透明：颜色还原原图，与深色
    // 主题一致——0.86 时与浅底混合 14% 会把颜色漂白）。
    ctx.globalAlpha = darkTheme ? .88 : 1
    paints.forEach((color, index) => {
      ctx.fillStyle = color
      ctx.fill(paths[index])
    })
    ctx.globalCompositeOperation = 'source-over'
  } else {
    ctx.globalAlpha = .28
    ctx.strokeStyle = palette.primary
    ctx.lineWidth = 1.2
    ctx.stroke(tailPaths[0])
    ctx.strokeStyle = palette.secondary
    ctx.stroke(tailPaths[1])
    ctx.strokeStyle = palette.accent
    ctx.stroke(tailPaths[2])
    ctx.globalAlpha = darkTheme ? .72 : 1
    ctx.fillStyle = palette.primary
    ctx.fill(paths[0])
    ctx.globalAlpha = darkTheme ? .46 : .9
    ctx.fillStyle = palette.secondary
    ctx.fill(paths[1])
    ctx.globalAlpha = .9
    ctx.fillStyle = palette.accent
    ctx.fill(paths[2])
  }
  // 逸散发光碎屑（优化点 ③）：缓慢漂移 + 正弦闪烁；主粒子静止时它们仍微微
  // 浮动，给点阵加呼吸感（backdrop 不生成，reduced-motion 不生成）。
  if (ambient.length) {
    for (const dot of ambient) {
      const pulse = 0.5 + 0.5 * Math.sin(dot.phase)
      const color = paints
        ? paints[dot.paint % paints.length]
        : (dot.paint === 2 ? palette.accent : palette.primary)
      // 无衬点：浅色主题下亮色碎屑自然淡出（与深色主题下暗色碎屑淡出对称），
      // 垫衬点实测变成背景上的「屏幕灰尘/噪点」（2026-08-16 vision 三轮）。
      ctx.globalAlpha = (0.14 + 0.24 * pulse) * energyScale
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.arc(dot.x, dot.y, dot.size, 0, Math.PI * 2)
      ctx.fill()
    }
  }
  ctx.globalAlpha = 1
}

function renderFrame(now: number) {
  if (!visible || document.hidden || reduceMotion.value) return
  if (lastFrame) {
    const elapsed = now - lastFrame
    slowFrames = elapsed > 28 ? slowFrames + 1 : Math.max(0, slowFrames - 2)
    if (slowFrames >= 20 && qualityScale > 0.48) {
      qualityScale *= 0.7
      slowFrames = 0
      setShape(false)
    }
  }
  lastFrame = now
  const moving = simulateParticles(now)
  const ambientElapsed = lastAmbientFrame ? Math.min(48, Math.max(1, now - lastAmbientFrame)) : 16.67
  lastAmbientFrame = now
  updateAmbient(ambientElapsed / 16.67)
  draw()
  if (!moving && props.density === 'backdrop') stopLoop()
}

function startLoop() {
  if (stopScheduledFrame || !performance.active.value || !visible || document.hidden || reduceMotion.value) return
  lastFrame = 0
  lastPhysicsFrame = 0
  // 2026-08-15（用户决策：性能充裕，放开帧率）：不再按密度节流（60/45/30fps），
  // 走 registerParticleFrame 的 fps<=0 原生模式——每个 rAF 都渲染，跑满显示器刷新率。
  // 物理模拟按 elapsed 时间步进（上限 32ms），高刷下不会变速；slowFrames 自愈仍保护低端机。
  stopScheduledFrame = registerParticleFrame(renderFrame, lowEffects.value ? 20 : 0)
}

function stopLoop() {
  stopScheduledFrame?.()
  stopScheduledFrame = null
  lastFrame = 0
  lastPhysicsFrame = 0
  lastAmbientFrame = 0
}

function resize() {
  if (!host.value || !canvas.value) return
  const rect = host.value.getBoundingClientRect()
  width = Math.max(1, Math.round(rect.width))
  height = Math.max(1, Math.round(rect.height))
  // 剪影模式按 HiDPI 全分辨率渲染：小网点在高分屏上边缘锐利（模糊感来源之一
  // 就是 dpr 上限偏低把网点糊掉）；抽象形状维持原上限。
  const dprLimit = portraitCloud
    ? 2
    : props.density === 'hero' ? 1.5 : props.density === 'ambient' ? 1.35 : 1.2
  dpr = Math.min(window.devicePixelRatio || 1, dprLimit)
  canvas.value.width = Math.round(width * dpr)
  canvas.value.height = Math.round(height * dpr)
  canvas.value.style.width = `${width}px`
  canvas.value.style.height = `${height}px`
  try {
    // 2026-08-16 回退 desynchronized 实验：部分 GPU/WebView2 的 overlay 路径
    // 会让 desynchronized 画布整块渲染成纯黑（灵感场景/效果样张页实锤）；
    // 参考实现（Arknights-FlowingPoints）也用普通 2d 上下文。
    context = canvas.value.getContext('2d')
  } catch {
    context = null
  }
  canvasAvailable.value = context !== null
  if (!context) {
    stopLoop()
    return
  }
  context?.setTransform(dpr, 0, 0, dpr, 0, 0)
  setShape(false)
}

function onPointerMove(event: PointerEvent) {
  if (!host.value || event.pointerType === 'touch') return
  const rect = host.value.getBoundingClientRect()
  pointerX = event.clientX - rect.left
  pointerY = event.clientY - rect.top
  pointerActive = true
  startLoop()
}

function onPointerLeave() {
  pointerActive = false
  startLoop()
}

watch(() => props.shape, () => { if (!portraitCloud) setShape(true) })
watch(() => props.portraitId, id => { void applyPortrait(id) })
watch(() => props.density, () => {
  stopLoop()
  resize()
  startLoop()
})
watch(() => props.signal, () => startLoop())

/** 角色剪影点云异步接管：加载完成前维持现有形状，完成后平滑形变成人物轮廓。 */
async function applyPortrait(id: string) {
  const token = ++portraitToken
  if (!id) {
    portraitCloud = null
    portraitPaints = []
    portraitRaw = []
    portraitRadii = []
    portraitActive.value = false
    setShape(true)
    return
  }
  const cloud = await loadPortraitCloud(id)
  if (token !== portraitToken) return
  portraitCloud = cloud
  portraitPaints = cloud ? cloud.palette.map(legibleColor) : []
  portraitRaw = cloud ? cloud.palette.slice() : []
  // 网点半径在 setShape 里按「点距 × 明暗」自适应计算（依赖粒子数与场域尺寸）
  portraitRadii = portraitPaints.map(() => 1)
  portraitActive.value = cloud !== null
  setShape(true)
}

onMounted(() => {
  if (!host.value || !canvas.value) return
  performance.active.value = true
  performance.syncEffectsPreference(false)
  motionMedia = window.matchMedia('(prefers-reduced-motion: reduce)')
  performance.onMotionPreference(motionMedia)
  motionMedia.addEventListener('change', performance.onMotionPreference)
  resizeObserver = new ResizeObserver(resize)
  resizeObserver.observe(host.value)
  intersectionObserver = new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? true
    if (visible) startLoop()
    else stopLoop()
  }, { rootMargin: '120px' })
  intersectionObserver.observe(host.value)
  themeObserver = new MutationObserver(performance.onRootPreferenceChanged)
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-fluid-effects', 'data-reduced-glass'] })
  document.addEventListener('visibilitychange', performance.onVisibilityChange)
  readPalette()
  resize()
  startLoop()
  if (props.portraitId) void applyPortrait(props.portraitId)
})

onUnmounted(() => {
  performance.active.value = false
  stopLoop()
  if (paletteFrame) cancelAnimationFrame(paletteFrame)
  resizeObserver?.disconnect()
  intersectionObserver?.disconnect()
  themeObserver?.disconnect()
  motionMedia?.removeEventListener('change', performance.onMotionPreference)
  document.removeEventListener('visibilitychange', performance.onVisibilityChange)
})
</script>

<style scoped>
.semantic-particle-field {
  --particle-primary: var(--text-primary);
  --particle-secondary: var(--text-muted);
  --particle-accent: var(--archive-blue);
  position:relative;
  min-width:0;
  min-height:260px;
  overflow:hidden;
  isolation:isolate;
  margin:0;
  background:
    linear-gradient(90deg,color-mix(in srgb,var(--border-soft) 54%,transparent) 1px,transparent 1px),
    linear-gradient(color-mix(in srgb,var(--border-soft) 54%,transparent) 1px,transparent 1px),
    radial-gradient(circle at 50% 48%,color-mix(in srgb,var(--particle-accent) 10%,transparent),transparent 55%);
  background-size:42px 42px,42px 42px,auto;
}
.semantic-particle-field::before,
.semantic-particle-field::after {
  content:"";
  position:absolute;
  pointer-events:none;
  z-index:var(--z-base);
}
.semantic-particle-field::before {
  inset:var(--s-3);
  border:1px solid color-mix(in srgb,var(--border-soft) 76%,transparent);
  clip-path:polygon(0 0,24% 0,24% 1px,76% 1px,76% 0,100% 0,100% 100%,76% 100%,76% calc(100% - 1px),24% calc(100% - 1px),24% 100%,0 100%);
}
.semantic-particle-field::after {
  left:50%; top:50%; width:5px; height:5px;
  border:1px solid var(--particle-accent);
  transform:translate(-50%,-50%) rotate(45deg);
  opacity:.7;
}
/* 图片点阵成像时隐藏中央菱形标记：它透在图片上会读成"幽灵图元" */
.has-portrait::after { display:none; }
canvas { display:none; position:absolute; inset:0; width:100%; height:100%; z-index:var(--z-base); }
.has-canvas canvas { display:block; }
.particle-fallback { display:grid; position:absolute; inset:0; place-items:center; }
.has-canvas .particle-fallback { display:none; }
.particle-fallback span { position:absolute; width:3px; height:3px; border-radius:50%; background:var(--particle-primary); transform:rotate(calc(var(--fallback-index,1) * 20deg)) translateX(72px); }
.particle-fallback span:nth-child(3n) { background:var(--particle-accent); }
.particle-caption {
  position:absolute; z-index:var(--z-raised); right:var(--s-4); bottom:var(--s-3);
  color:var(--text-muted); font:650 var(--fs-mono-xs) var(--font-mono);
  letter-spacing:.12em; text-transform:uppercase;
}
.density-ambient { min-height:100%; background-size:56px 56px,56px 56px,auto; }
.density-backdrop { min-height:100%; background-size:64px 64px,64px 64px,auto; }
.is-bare { min-height:100%; background:none; }
.is-bare::before,.is-bare::after,.is-bare .particle-caption { display:none; }
.signal-active canvas { opacity:.92; }
.signal-warning canvas { opacity:.86; }
@media (max-width: 768px) {
  .semantic-particle-field { min-height:240px; background-size:34px 34px,34px 34px,auto; }
  .particle-caption { right:var(--s-3); }
}
@media (prefers-reduced-motion:reduce) {
  .semantic-particle-field { background-image:radial-gradient(circle at 50% 48%,color-mix(in srgb,var(--particle-accent) 12%,transparent),transparent 55%); }
}
</style>
