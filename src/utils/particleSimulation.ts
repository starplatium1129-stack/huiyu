import type { ParticlePoint } from './particleShapes'

export interface RuntimeParticle {
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

function targetPosition(point: ParticlePoint, width: number, height: number, portrait: boolean): { x: number; y: number } {
  // 剪影模式边距收窄（4%）：配合点云内容盒 1.02，人物实际占屏约 94%，
  // 消除「人物显小、留白过多」；抽象形状维持 8% 经典边距。
  const paddingX = portrait ? Math.max(10, width * 0.04) : Math.max(22, width * 0.08)
  const paddingY = portrait ? Math.max(10, height * 0.04) : Math.max(20, height * 0.08)
  return {
    x: paddingX + point.x * Math.max(1, width - paddingX * 2),
    y: paddingY + point.y * Math.max(1, height - paddingY * 2),
  }
}

export function retargetParticles(particles: RuntimeParticle[], shape: ParticlePoint[], width: number, height: number, animate: boolean, portrait: boolean): RuntimeParticle[] {
  const previous = particles.toSorted((a, b) => {
    const rowA = Math.round(a.y / Math.max(1, height) * 18)
    const rowB = Math.round(b.y / Math.max(1, height) * 18)
    return rowA === rowB ? a.x - b.x : rowA - rowB
  })

  return shape.map((point, index) => {
    const target = targetPosition(point, width, height, portrait)
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
      size: current?.size ?? (portrait ? 1 : 0.88 + Math.random() * 0.24),
    }
  })
}

/**
 * 物理模型逐项对标 Arknights-FlowingPoints 的 CONFIG（2026-08-16 起全站统一，
 * 不再区分剪影/抽象形状）：斥力半径 105px 固定、平方衰减力 1.8、恒定回位
 * 弹簧 0.01（慢回流=流动感）、摩擦 0.15/帧；无待机漂移、无点击脉冲、无指针
 * 高光——参考实现均没有这些。step 按帧时长归一（高刷屏不变速）。
 */
export function simulateParticles(particles: RuntimeParticle[], elapsed: number, interactive: boolean,
  pointerActive: boolean, pointerX: number, pointerY: number): boolean {
  const step = elapsed / 16.67
  const interactionRadius = 105
  const interactionRadiusSquared = interactionRadius * interactionRadius
  const damping = Math.pow(0.85, step)
  let moving = pointerActive

  for (const particle of particles) {
    particle.prevX = particle.x
    particle.prevY = particle.y
    particle.velocityX += (particle.targetX - particle.x) * 0.01 * step
    particle.velocityY += (particle.targetY - particle.y) * 0.01 * step

    if (interactive && pointerActive) {
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

    particle.velocityX *= damping
    particle.velocityY *= damping
    particle.x += particle.velocityX * step
    particle.y += particle.velocityY * step

    if (Math.abs(particle.velocityX) > 0.012 || Math.abs(particle.velocityY) > 0.012
      || Math.abs(particle.targetX - particle.x) > 0.12 || Math.abs(particle.targetY - particle.y) > 0.12) {
      moving = true
    }
  }

  return moving
}
