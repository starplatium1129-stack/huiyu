import { particleNeedsOutline } from './particlePortrait'

// Shared by Canvas, GPU masks and dirty bounds so theme tuning stays identical.
export const LIGHT_PARTICLE_SCALE = 1.32
export const PARTICLE_EDGE_SCALE = 1.08
export const LIGHT_PARTICLE_EDGE_ALPHA = .38
export const LIGHT_PARTICLE_TAIL_ALPHA = .16

export interface ParticleBodyPoint {
  x: number; y: number; prevX: number; prevY: number; targetX: number; targetY: number
  tone: 0 | 1 | 2; paint: number; size: number
}

export interface ParticleBodyStyle {
  paints: string[] | null; radii: number[]; darkTheme: boolean; energyScale: number
  surface: string; outline: string
  palette: { primary: string; secondary: string; accent: string }
}

/** Original color-batched circles, outlines and tails; shared by full and clipped drawing. */
export function drawParticleBody(ctx: CanvasRenderingContext2D, particles: readonly ParticleBodyPoint[], style: ParticleBodyStyle) {
  const { paints, radii, darkTheme, energyScale, surface, outline, palette } = style
  const paths = paints
    ? paints.map(() => new Path2D())
    : [new Path2D(), new Path2D(), new Path2D()]
  // 运动拖尾（对齐参考实现的残影流光）：粒子位移超过阈值时连一条
  // 上一帧→当前帧线段；静止粒子不入路径——空闲观感不变，交互涟漪带出流光。
  const tailPaths = paths.map(() => new Path2D())
  // Light-mode points retain their original colors. A thin concentric ink edge
  // separates low-contrast colors from the paper surface without darkening their centers.
  const shadowFlags = paints && !darkTheme ? paints.map(color => particleNeedsOutline(color, surface)) : null
  const shadowPaths = shadowFlags?.some(Boolean) ? shadowFlags.map(outline => outline ? new Path2D() : null) : null
  const underColor = outline

  for (const particle of particles) {
    const pathIndex = paints
      ? Math.min(paths.length - 1, Math.max(0, particle.paint))
      : particle.tone
    const path = paths[pathIndex]
    // 图片点阵（剪影/整图复刻）统一点径；抽象形状维持经典三档点径
    // （0.78/1.05/1.55 的层次 + 强调色亮点——2026-08-16 用户决策恢复，
    // 统一大点径在稀疏轮廓形状上显得粗笨）
    const baseRadius = paints
      ? (radii[pathIndex] || 1)
      : particle.tone === 2 ? 1.55 : particle.tone === 1 ? 1.05 : 0.78
    const radius = baseRadius * (paints && !darkTheme ? LIGHT_PARTICLE_SCALE : 1) * energyScale * particle.size
    const dx = particle.x - particle.prevX
    const dy = particle.y - particle.prevY
    if (dx * dx + dy * dy > 0.12) {
      tailPaths[pathIndex].moveTo(particle.prevX, particle.prevY)
      tailPaths[pathIndex].lineTo(particle.x, particle.y)
    }
    if (shadowPaths) {
      const shadow = shadowPaths[pathIndex]
      if (shadow) {
        // A fine, translucent edge separates pale colors without a dark mesh.
        shadow.moveTo(particle.x + radius * PARTICLE_EDGE_SCALE, particle.y)
        shadow.arc(particle.x, particle.y, radius * PARTICLE_EDGE_SCALE, 0, Math.PI * 2)
      }
    }
    path.moveTo(particle.x + radius, particle.y)
    path.arc(particle.x, particle.y, radius, 0, Math.PI * 2)
  }
  // 先拖尾后头点：流光在点后，头点保持锐利；混合模式跟随主体（深色 screen 发光）。
  ctx.lineCap = 'round'
  if (paints) {
    ctx.globalCompositeOperation = darkTheme ? 'screen' : 'source-over'
    // Pale source colors keep their centers; only their edge gets a soft underlay.
    if (shadowPaths) {
      ctx.globalCompositeOperation = 'source-over'
      ctx.globalAlpha = LIGHT_PARTICLE_EDGE_ALPHA
      ctx.fillStyle = underColor
      shadowPaths.forEach((path) => { if (path) ctx.fill(path) })
      ctx.globalCompositeOperation = darkTheme ? 'screen' : 'source-over'
    }
    // 浅色主题拖尾先垫深色衬线：亮色流光在浅底上同样会「隐形」，交互时
    // 涟漪残影要保持可见；深色主题 screen 下亮色自带发光，无需衬线。
    if (!darkTheme) {
      ctx.globalAlpha = LIGHT_PARTICLE_TAIL_ALPHA
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
  ctx.globalAlpha = 1
}
