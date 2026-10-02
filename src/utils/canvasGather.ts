const MAX_PARTICLES = 1200
const MAX_PIXELS = 1_000_000

/** A finite layer of sampled-color dust. The real img remains the only artwork
 * renderer: no enlarged snapshot, image deformation, or full-resolution readback. */
export function startCanvasGather(image: HTMLImageElement, host: HTMLElement, duration: number): (() => void) | null {
  duration = Number.isFinite(duration) ? Math.max(160, Math.min(1000, duration)) : 740
  if (!image.complete || !image.naturalWidth || !image.naturalHeight) return null
  const rect = image.getBoundingClientRect(), hostRect = host.getBoundingClientRect()
  if (rect.width < 1 || rect.height < 1 || !Number.isFinite(rect.width * rect.height)) return null
  const fit = Math.min(rect.width / image.naturalWidth, rect.height / image.naturalHeight)
  const width = image.naturalWidth * fit, height = image.naturalHeight * fit
  const left = (rect.width - width) / 2, top = (rect.height - height) / 2
  const canvas = document.createElement('canvas'), sample = document.createElement('canvas')
  const scale = Math.min(window.devicePixelRatio || 1, 1.5, 1280 / Math.max(rect.width, rect.height),
    Math.sqrt(MAX_PIXELS / (rect.width * rect.height)))
  canvas.width = Math.max(1, Math.floor(rect.width * scale))
  canvas.height = Math.max(1, Math.floor(rect.height * scale))
  const count = Math.min(MAX_PARTICLES, Math.max(1, Math.ceil(width * height / 500)))
  sample.width = Math.max(1, Math.min(count, Math.round(Math.sqrt(count * width / height))))
  sample.height = Math.max(1, Math.floor(count / sample.width))
  const grains: Array<{ x: number; y: number; dx: number; dy: number; delay: number; size: number; color: string; alpha: number }> = []
  let frame: number | null = null
  let disposed = false
  const cleanup = () => {
    if (disposed) return
    disposed = true
    if (frame !== null) cancelAnimationFrame(frame)
    frame = null
    canvas.remove()
    canvas.width = canvas.height = sample.width = sample.height = 0
    grains.length = 0
  }
  try {
    const context = canvas.getContext('2d'), reader = sample.getContext('2d', { willReadFrequently: true })
    if (!context || !reader) { cleanup(); return null }
    reader.drawImage(image, 0, 0, sample.width, sample.height)
    const pixels = reader.getImageData(0, 0, sample.width, sample.height).data
    for (let y = 0; y < sample.height; y++) {
      for (let x = 0; x < sample.width; x++) {
        const p = (y * sample.width + x) * 4
        const nx = (x + 0.5) / sample.width, ny = (y + 0.5) / sample.height
        const drift = 20 + Math.random() * 42
        grains.push({
          x: left + nx * width, y: top + ny * height,
          dx: (nx < 0.5 ? -1 : 1) * drift, dy: -12 - Math.random() * 28,
          delay: Math.abs(nx - 0.5) * 0.12 + Math.random() * 0.08,
          size: 1 + Math.random() * 1.4,
          color: `rgb(${pixels[p]}, ${pixels[p + 1]}, ${pixels[p + 2]})`, alpha: pixels[p + 3] / 255,
        })
      }
    }
    sample.width = sample.height = 0
    canvas.className = 'cg-gather-dust'
    canvas.setAttribute('aria-hidden', 'true')
    Object.assign(canvas.style, {
      position: 'absolute', pointerEvents: 'none', zIndex: '1',
      left: `${rect.left - hostRect.left - host.clientLeft + host.scrollLeft}px`,
      top: `${rect.top - hostRect.top - host.clientTop + host.scrollTop}px`,
      width: `${rect.width}px`, height: `${rect.height}px`,
    })
    context.setTransform(canvas.width / rect.width, 0, 0, canvas.height / rect.height, 0, 0)
    host.appendChild(canvas)
    const start = performance.now()
    let lastStep = -1
    function render(now: number) {
      if (disposed) return
      frame = null
      const elapsed = Math.max(0, now - start)
      if (elapsed >= duration) { cleanup(); return }
      const step = Math.floor(elapsed / (1000 / 60))
      if (step !== lastStep) {
        lastStep = step
        try {
          /* compositor-exempt: sampled dust converges independently; one finite
           * <=1000ms loop, <=1200 grains, <=1MP backing and <=60 paints/sec. */
          context!.clearRect(0, 0, rect.width, rect.height)
          for (const grain of grains) {
            const t = Math.max(0, Math.min(1, (elapsed / duration - grain.delay) / (1 - grain.delay)))
            const away = Math.pow(1 - Math.min(1, t / 0.7), 3)
            context!.globalAlpha = grain.alpha * Math.min(1, t * 12) * Math.pow(1 - t, 1.3)
            context!.fillStyle = grain.color
            context!.fillRect(grain.x + grain.dx * away, grain.y + grain.dy * away + Math.sin(t * Math.PI) * 5, grain.size, grain.size)
          }
          context!.globalAlpha = 1
        } catch { cleanup(); return }
      }
      frame = requestAnimationFrame(render)
    }
    frame = requestAnimationFrame(render)
    return cleanup
  } catch { cleanup(); return null }
}
