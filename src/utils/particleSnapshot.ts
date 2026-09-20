import { drawParticleBody, type ParticleBodyPoint, type ParticleBodyStyle } from './particleBody'

interface DirtyRect { x: number; y: number; width: number; height: number }

/** Include circle outlines, round tail caps and one device pixel of antialiasing. */
function paintMargin(point: ParticleBodyPoint, style: ParticleBodyStyle, dpr: number): number {
  const index = style.paints ? Math.min(style.paints.length - 1, Math.max(0, point.paint)) : point.tone
  const base = style.paints ? (style.radii[index] || 1) : point.tone === 2 ? 1.55 : point.tone === 1 ? 1.05 : .78
  const radius = base * (style.paints && !style.darkTheme ? 1.35 : 1) * style.energyScale * point.size
  return Math.max(radius * 1.12, 1.2) + 1 / dpr
}

/** Cover both the target dots to erase and the moving heads/tails to replace them. */
export function particleDirtyRect(points: readonly ParticleBodyPoint[], style: ParticleBodyStyle, width: number, height: number, dpr: number): DirtyRect | null {
  let left = width, top = height, right = 0, bottom = 0
  for (const point of points) {
    // Physics continues unchanged. Sub-thousandth-pixel residuals are visually settled.
    if (Math.abs(point.x - point.targetX) <= .001 && Math.abs(point.y - point.targetY) <= .001
      && Math.abs(point.prevX - point.targetX) <= .001 && Math.abs(point.prevY - point.targetY) <= .001) continue
    const margin = paintMargin(point, style, dpr)
    left = Math.min(left, point.targetX - margin, point.x - margin, point.prevX - margin)
    top = Math.min(top, point.targetY - margin, point.y - margin, point.prevY - margin)
    right = Math.max(right, point.targetX + margin, point.x + margin, point.prevX + margin)
    bottom = Math.max(bottom, point.targetY + margin, point.y + margin, point.prevY + margin)
  }
  // Align clip edges to physical pixels, avoiding an antialiased seam in the cached body.
  left = Math.max(0, Math.floor(left * dpr)) / dpr
  top = Math.max(0, Math.floor(top * dpr)) / dpr
  right = Math.min(Math.round(width * dpr), Math.ceil(right * dpr)) / dpr
  bottom = Math.min(Math.round(height * dpr), Math.ceil(bottom * dpr)) / dpr
  return right > left && bottom > top ? { x: left, y: top, width: right - left, height: bottom - top } : null
}

/** Include stationary neighbours and tails crossing the clip, preserving the original paint order. */
export function particlesInDirtyRect(points: readonly ParticleBodyPoint[], style: ParticleBodyStyle, dpr: number, rect: DirtyRect): ParticleBodyPoint[] {
  const right = rect.x + rect.width, bottom = rect.y + rect.height
  return points.filter(point => {
    const margin = paintMargin(point, style, dpr)
    return Math.max(point.x, point.prevX) + margin >= rect.x && Math.min(point.x, point.prevX) - margin <= right
      && Math.max(point.y, point.prevY) + margin >= rect.y && Math.min(point.y, point.prevY) - margin <= bottom
  })
}

/** Cache only target-position body pixels; redraw the disturbed region with the same vector pipeline. */
export function createParticleSnapshot() {
  let image: HTMLCanvasElement | null = null
  let valid = false
  return {
    invalidate() { valid = false },
    draw(context: CanvasRenderingContext2D, width: number, height: number, dpr: number,
      points: readonly ParticleBodyPoint[], style: ParticleBodyStyle): number {
      image ??= document.createElement('canvas')
      if (image.width !== Math.round(width * dpr) || image.height !== Math.round(height * dpr)) {
        image.width = Math.round(width * dpr); image.height = Math.round(height * dpr); valid = false
      }
      if (!valid) {
        const body = image.getContext('2d', context.getContextAttributes())
        if (!body) { drawParticleBody(context, points, style); return points.length }
        body.setTransform(dpr, 0, 0, dpr, 0, 0)
        body.clearRect(0, 0, width, height)
        drawParticleBody(body, points.map(point => ({ ...point,
          x: point.targetX, y: point.targetY, prevX: point.targetX, prevY: point.targetY })), style)
        valid = true
      }
      const rect = particleDirtyRect(points, style, width, height, dpr)
      // A character transition can disturb the whole field: skip an unnecessary bitmap copy.
      if (rect && rect.width * rect.height > width * height * .65) {
        drawParticleBody(context, points, style)
        return points.length
      }
      context.save()
      context.setTransform(1, 0, 0, 1, 0, 0)
      context.globalAlpha = 1
      context.globalCompositeOperation = 'source-over'
      context.drawImage(image, 0, 0)
      context.restore()
      if (!rect) return 0
      const affected = particlesInDirtyRect(points, style, dpr, rect)
      context.save()
      context.beginPath()
      context.rect(rect.x, rect.y, rect.width, rect.height)
      context.clip()
      context.clearRect(rect.x, rect.y, rect.width, rect.height)
      drawParticleBody(context, affected, style)
      context.restore()
      return affected.length
    },
    release() { if (image) { image.width = 0; image.height = 0 }; image = null; valid = false },
  }
}

