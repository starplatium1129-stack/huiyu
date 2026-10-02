const GROUPS = 4
const MAX_GRAINS = 2600
const MAX_BACKING_PIXELS = 1_000_000
const MAX_EDGE = 768
const BLEED = 36

function noise(index: number, seed: number): number {
  const value = Math.sin(index * 127.1 + seed * 311.7) * 43758.5453
  return value - Math.floor(value)
}

/** Sample the artwork once into fine, scattered color grains. Four prepainted
 * depth layers settle using only transform/opacity; the stationary original
 * fades in beneath them. No recurring JS paint or per-particle DOM allocation. */
export function startCanvasParticleReveal(image: HTMLImageElement, host: HTMLElement, duration: number): { finished: Promise<void>; stop: () => void } | null {
  if (!image.complete || !image.naturalWidth || !image.naturalHeight || typeof image.animate !== 'function') return null
  const rect = image.getBoundingClientRect(), parent = host.getBoundingClientRect()
  if (rect.width < 1 || rect.height < 1 || !Number.isFinite(rect.width * rect.height)) return null
  const fit = Math.min(rect.width / image.naturalWidth, rect.height / image.naturalHeight)
  const width = image.naturalWidth * fit, height = image.naturalHeight * fit
  const target = Math.min(MAX_GRAINS, Math.max(1, Math.ceil(width * height / 90)))
  const columns = Math.max(1, Math.min(target, Math.round(Math.sqrt(target * width / height))))
  const rows = Math.max(1, Math.floor(target / columns))
  const sample = document.createElement('canvas')
  sample.width = columns; sample.height = rows
  const layer = document.createElement('div')
  layer.className = 'cg-particle-reveal'
  layer.setAttribute('aria-hidden', 'true')
  Object.assign(layer.style, {
    position: 'absolute', pointerEvents: 'none', zIndex: '1',
    left: `${rect.left - parent.left - host.clientLeft + host.scrollLeft + (rect.width - width) / 2}px`,
    top: `${rect.top - parent.top - host.clientTop + host.scrollTop + (rect.height - height) / 2}px`,
    width: `${width}px`, height: `${height}px`,
  })
  const viewWidth = width + BLEED * 2, viewHeight = height + BLEED * 2
  const scale = Math.min(window.devicePixelRatio || 1, 1.5, MAX_EDGE / Math.max(viewWidth, viewHeight),
    Math.sqrt(MAX_BACKING_PIXELS / GROUPS / (viewWidth * viewHeight)))
  const canvases: HTMLCanvasElement[] = []
  const animations: Animation[] = []
  const completions: Promise<Animation>[] = []
  let disposed = false
  const stop = () => {
    if (disposed) return
    disposed = true
    // Cancel only animations owned by this effect; the image's original style
    // immediately becomes authoritative again, including on partial failure.
    animations.forEach(animation => animation.cancel())
    layer.remove()
    for (const canvas of [sample, ...canvases]) canvas.width = canvas.height = 0
  }
  const own = (animation: Animation) => {
    animations.push(animation)
    const completion = animation.finished
    void completion.catch(() => {})
    completions.push(completion)
  }
  duration = Number.isFinite(duration) ? Math.max(240, Math.min(1200, duration)) : 960
  try {
    const reader = sample.getContext('2d', { willReadFrequently: true })
    if (!reader) { stop(); return null }
    reader.drawImage(image, 0, 0, columns, rows)
    // Only this <=2600px thumbnail is read. A tainted source fails before the
    // original is faded, so CORS restrictions cannot leave an empty canvas.
    const pixels = reader.getImageData(0, 0, columns, rows).data
    const radius = Math.min(2.1, Math.max(.85, Math.min(width / columns, height / rows) * .13))
    const motions = [[-1, .6, 1.035], [.8, -.8, 1.055], [-.5, -1, 1.02], [1, .4, 1.045]]
    for (let group = 0; group < GROUPS; group++) {
      const canvas = document.createElement('canvas')
      canvases.push(canvas)
      canvas.width = Math.max(1, Math.floor(viewWidth * scale))
      canvas.height = Math.max(1, Math.floor(viewHeight * scale))
      const context = canvas.getContext('2d')
      if (!context) { stop(); return null }
      context.setTransform(canvas.width / viewWidth, 0, 0, canvas.height / viewHeight, 0, 0)
      for (let index = group; index < columns * rows; index += GROUPS) {
        // Scatter in continuous space, then pick the nearest sampled color.
        // Animating a jittered grid still reads as rows of pixels in slow motion.
        const u = noise(index, 1), v = noise(index, 2)
        const p = (Math.floor(v * rows) * columns + Math.floor(u * columns)) * 4
        if (pixels[p + 3] < 8) continue
        const x = u * width, y = v * height
        context.fillStyle = `rgb(${pixels[p]}, ${pixels[p + 1]}, ${pixels[p + 2]})`
        context.globalAlpha = pixels[p + 3] / 255 * (.55 + noise(index, 3) * .45)
        context.beginPath()
        context.arc(BLEED + x, BLEED + y, radius * (.65 + noise(index, 4) * .7), 0, Math.PI * 2)
        context.fill()
      }
      Object.assign(canvas.style, {
        position: 'absolute', left: `${-BLEED}px`, top: `${-BLEED}px`,
        width: `${viewWidth}px`, height: `${viewHeight}px`,
      })
      layer.append(canvas)
      const [dx, dy, expansion] = motions[group]
      const travel = Math.min(26, Math.max(10, width * .04))
      own(canvas.animate([
        { opacity: .4, transform: `translate3d(${dx * travel}px,${dy * travel}px,0) scale(${expansion})` },
        { opacity: .95, offset: .16 },
        { opacity: .42, offset: .34 },
        { opacity: .08, transform: 'translate3d(0,0,0) scale(1)', offset: .6 },
        { opacity: 0, transform: 'translate3d(0,0,0) scale(1)' },
      ], { duration, easing: 'linear', fill: 'both' }))
    }
    sample.width = sample.height = 0
    const originalOpacity = Number.parseFloat(getComputedStyle(image).opacity)
    // The image is never resized, displaced, blurred, or replaced. Prepare all
    // grain layers before giving them the brief leading part of the handoff.
    own(image.animate([
      { opacity: 0 }, { opacity: Number.isFinite(originalOpacity) ? originalOpacity : 1 },
    ], { delay: duration * .14, duration: duration * .7, easing: 'cubic-bezier(.25,.1,.25,1)', fill: 'both' }))
    host.append(layer)
    const finished = Promise.all(completions).then(() => { stop() }, () => { stop() })
    return { finished, stop }
  } catch { stop(); return null }
}
