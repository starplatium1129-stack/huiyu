const CANVAS_DURATION = 1480
const THUMBNAIL_DURATION = 740
const PAINT_INTERVAL = 1000 / 60
const MAX_PARTICLES = 2400
const MAX_PIXELS = 1_000_000
const MAX_EDGE = 1280
const BLEED = 72

interface Grain {
  patchX: number
  patchY: number
  patchWidth: number
  patchHeight: number
  sx: number
  sy: number
  x: number
  y: number
  delay: number
  life: number
  vx: number
  vy: number
  flutter: number
  size: number
  color: string
  alpha: number
}

function sizeBacking(canvas: HTMLCanvasElement, width: number, height: number, maxPixels: number, maxEdge: number): void {
  const scale = Math.min(window.devicePixelRatio || 1, 1.5,
    maxEdge / Math.max(width, height), Math.sqrt(maxPixels / (width * height)))
  canvas.width = Math.max(1, Math.floor(width * scale))
  canvas.height = Math.max(1, Math.floor(height * scale))
}

/** Capture the decoded, centered object-fit:contain image synchronously before
 * its URL is revoked. The host must establish an absolute-positioning context.
 * Returns null when capture is unavailable (including cross-origin taint).
 */
export function startCanvasDissolve(image: HTMLImageElement, host: HTMLElement, profile: 'canvas' | 'thumbnail' = 'canvas',
  lifecycle?: { onHandoff?: () => void; onComplete?: () => void }): (() => void) | null {
  const duration = profile === 'canvas' ? CANVAS_DURATION : THUMBNAIL_DURATION
  const pace = duration / THUMBNAIL_DURATION
  const maxParticles = profile === 'thumbnail' ? 1200 : MAX_PARTICLES
  const maxPixels = profile === 'thumbnail' ? 300_000 : MAX_PIXELS
  const maxEdge = profile === 'thumbnail' ? 640 : MAX_EDGE
  if (!image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0) return null
  const rect = image.getBoundingClientRect(), hostRect = host.getBoundingClientRect()
  if (rect.width < 1 || rect.height < 1 || !Number.isFinite(rect.width * rect.height)) return null
  const fit = Math.min(rect.width / image.naturalWidth, rect.height / image.naturalHeight)
  const width = image.naturalWidth * fit, height = image.naturalHeight * fit
  const left = BLEED + (rect.width - width) / 2, top = BLEED + (rect.height - height) / 2
  const viewWidth = rect.width + BLEED * 2, viewHeight = rect.height + BLEED * 2
  const overlay = document.createElement('canvas')
  const snapshot = document.createElement('canvas')
  const sample = document.createElement('canvas')
  const grains: Grain[] = []
  let frame: number | null = null
  let disposed = false
  let handedOff = false

  function cleanup(): void {
    if (disposed) return
    disposed = true
    if (frame !== null) cancelAnimationFrame(frame)
    frame = null
    overlay.remove()
    for (const canvas of [overlay, snapshot, sample]) { canvas.width = 0; canvas.height = 0 }
    grains.length = 0
    lifecycle?.onComplete?.()
  }

  try {
    sizeBacking(overlay, viewWidth, viewHeight, maxPixels, maxEdge)
    sizeBacking(snapshot, width, height, maxPixels, maxEdge)
    // A single tiny readback, never a read of the full-size artwork or snapshot.
    const target = Math.min(maxParticles, Math.max(1, Math.ceil(width * height / 110)))
    const columns = Math.max(1, Math.min(target, Math.round(Math.sqrt(target * width / height))))
    const rows = Math.max(1, Math.floor(target / columns))
    sample.width = columns
    sample.height = rows
    const context = overlay.getContext('2d')
    const snapshotContext = snapshot.getContext('2d')
    const sampleContext = sample.getContext('2d', { willReadFrequently: true })
    if (!context || !snapshotContext || !sampleContext) { cleanup(); return null }
    snapshotContext.drawImage(image, 0, 0, snapshot.width, snapshot.height)
    sampleContext.drawImage(snapshot, 0, 0, columns, rows)
    const pixels = sampleContext.getImageData(0, 0, columns, rows).data
    sample.width = 0; sample.height = 0

    const cellWidth = width / columns, cellHeight = height / rows
    const sourceWidth = snapshot.width / columns, sourceHeight = snapshot.height / rows
    const backingScaleX = overlay.width / viewWidth, backingScaleY = overlay.height / viewHeight
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < columns; x++) {
        const p = (y * columns + x) * 4
        const noise = Math.random()
        const delay = (35 + x / columns * 205 + y / rows * 45 + noise * 35) * pace
        // Align adjacent source patches to complete backing pixels. Fractional
        // destinations leave antialiased seams before the breakup has started.
        const x0 = Math.round((left + x * cellWidth) * backingScaleX)
        const x1 = Math.round((left + (x + 1) * cellWidth) * backingScaleX)
        const y0 = Math.round((top + y * cellHeight) * backingScaleY)
        const y1 = Math.round((top + (y + 1) * cellHeight) * backingScaleY)
        grains.push({
          patchX: x0 / backingScaleX, patchY: y0 / backingScaleY,
          patchWidth: (x1 - x0) / backingScaleX, patchHeight: (y1 - y0) / backingScaleY,
          sx: x * sourceWidth, sy: y * sourceHeight,
          x: left + x * cellWidth, y: top + y * cellHeight,
          delay, life: duration - delay,
          vx: 28 + noise * 76, vy: -18 - Math.random() * 48,
          flutter: (Math.random() - 0.5) * 20,
          size: 1.2 + Math.random() * 1.6,
          color: `rgb(${pixels[p]}, ${pixels[p + 1]}, ${pixels[p + 2]})`,
          alpha: pixels[p + 3] / 255,
        })
      }
    }

    overlay.className = 'canvas-dissolve-overlay'
    overlay.setAttribute('aria-hidden', 'true')
    // Clear may interrupt the image's entrance animation. Keep its current
    // opacity instead of flashing the raw decoded pixels at full brightness.
    const opacity = Number.parseFloat(getComputedStyle(image).opacity)
    Object.assign(overlay.style, {
      position: 'absolute', pointerEvents: 'none', zIndex: '4',
      opacity: String(Number.isFinite(opacity) ? Math.max(0, Math.min(1, opacity)) : 1),
      left: `${rect.left - hostRect.left - host.clientLeft + host.scrollLeft - BLEED}px`,
      top: `${rect.top - hostRect.top - host.clientTop + host.scrollTop - BLEED}px`,
      width: `${viewWidth}px`, height: `${viewHeight}px`,
    })
    context.setTransform(overlay.width / viewWidth, 0, 0, overlay.height / viewHeight, 0, 0)
    // Preserve a recognizable first frame; subsequent frames fade source patches
    // into tiny sampled-color grains rather than starting from a blocky mosaic.
    context.drawImage(snapshot, left, top, width, height)
    host.appendChild(overlay)
    const startedAt = performance.now()
    let lastPaintStep = 0

    function render(now: number): void {
      if (disposed) return
      frame = null
      const elapsed = Math.max(0, now - startedAt)
      if (elapsed >= duration) { cleanup(); return }
      // Let waiting/empty content enter while the last dust is still receding.
      if (!handedOff && elapsed >= duration - 560) {
        handedOff = true
        lifecycle?.onHandoff?.()
      }
      // High-refresh rAF still owns cancellation and wall-clock completion, but
      // only one redraw is allowed in each 60Hz slot (no catch-up paint loops).
      const paintStep = Math.floor(elapsed / PAINT_INTERVAL)
      if (paintStep <= lastPaintStep) { frame = requestAnimationFrame(render); return }
      lastPaintStep = paintStep
      try {
        /* compositor-exempt: image breakup needs independent source patches and
         * dust grains; one finite <=1480ms loop, <=2400 grains and <=1MP backings. */
        context!.clearRect(0, 0, viewWidth, viewHeight)
        for (const grain of grains) {
          const age = Math.max(0, (elapsed - grain.delay) / grain.life)
          const patchAlpha = Math.max(0, 1 - age / (profile === 'canvas' ? 0.38 : 0.24))
          if (patchAlpha > 0) {
            context!.globalAlpha = patchAlpha
            context!.drawImage(snapshot, grain.sx, grain.sy, sourceWidth, sourceHeight,
              grain.patchX, grain.patchY, grain.patchWidth, grain.patchHeight)
          }
          if (age <= 0 || grain.alpha <= 0) continue
          context!.globalAlpha = grain.alpha * Math.min(1, age * 12) * Math.pow(1 - age, 1.4)
          context!.fillStyle = grain.color
          const drift = age * (0.6 + age * 0.4)
          const flutter = Math.sin(age * Math.PI * 2) * grain.flutter
          const size = grain.size * (1 - age * 0.65)
          context!.fillRect(grain.x + cellWidth / 2 + grain.vx * drift + flutter,
            grain.y + cellHeight / 2 + grain.vy * drift + flutter * 0.3, size, size)
        }
        context!.globalAlpha = 1
        frame = requestAnimationFrame(render)
      } catch { cleanup() }
    }
    frame = requestAnimationFrame(render)
    return cleanup
  } catch {
    cleanup()
    return null
  }
}
