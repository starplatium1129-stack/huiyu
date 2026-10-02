const BANDS = 10
const SAMPLE_EDGE = 64

/** A coarse image resolves into the original in a short diagonal wave. Canvas
 * only prepares tiny, cropped bitmaps once; the compositor animates opacity.
 * No pixel readback, GPU context, full-resolution copy, or per-frame JS work.
 * The decoded original remains stationary beneath the disposable layers. */
export function startCanvasPixelReveal(image: HTMLImageElement, host: HTMLElement, duration: number): { finished: Promise<void>; stop: () => void } | null {
  if (!image.complete || !image.naturalWidth || !image.naturalHeight || typeof image.animate !== 'function') return null
  const rect = image.getBoundingClientRect(), parent = host.getBoundingClientRect()
  if (rect.width < 1 || rect.height < 1 || !Number.isFinite(rect.width * rect.height)) return null
  const fit = Math.min(rect.width / image.naturalWidth, rect.height / image.naturalHeight)
  const width = image.naturalWidth * fit, height = image.naturalHeight * fit
  const columns = Math.max(1, Math.round(SAMPLE_EDGE * width / Math.max(width, height)))
  const rows = Math.max(1, Math.round(SAMPLE_EDGE * height / Math.max(width, height)))
  const sample = document.createElement('canvas')
  sample.width = columns; sample.height = rows
  const layer = document.createElement('div')
  layer.className = 'cg-pixel-reveal'
  layer.setAttribute('aria-hidden', 'true')
  Object.assign(layer.style, {
    position: 'absolute', pointerEvents: 'none', zIndex: '1', overflow: 'hidden',
    left: `${rect.left - parent.left - host.clientLeft + host.scrollLeft + (rect.width - width) / 2}px`,
    top: `${rect.top - parent.top - host.clientTop + host.scrollTop + (rect.height - height) / 2}px`,
    width: `${width}px`, height: `${height}px`,
  })
  const canvases: HTMLCanvasElement[] = []
  const animations: Animation[] = []
  const completions: Promise<Animation>[] = []
  let disposed = false
  const stop = () => {
    if (disposed) return
    disposed = true
    animations.forEach(animation => animation.cancel())
    layer.remove()
    for (const canvas of [sample, ...canvases]) canvas.width = canvas.height = 0
  }
  duration = Number.isFinite(duration) ? Math.max(240, Math.min(1000, duration)) : 860
  try {
    const reader = sample.getContext('2d')
    if (!reader) { stop(); return null }
    reader.drawImage(image, 0, 0, columns, rows)
    const cells: Array<Array<{ x: number; y: number }>> = Array.from({ length: BANDS }, () => [])
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < columns; x++) {
        // Fixed spatial jitter gives the advancing edge a pixel texture without flicker.
        const jitter = (((x * 17 + y * 31) % 11) / 10 - .5) * .14
        const wave = .58 * x / Math.max(1, columns - 1) + .42 * y / Math.max(1, rows - 1) + jitter
        cells[Math.max(0, Math.min(BANDS - 1, Math.floor(wave * BANDS)))].push({ x, y })
      }
    }
    for (const [index, band] of cells.entries()) {
      if (!band.length) continue
      const left = Math.min(...band.map(cell => cell.x)), top = Math.min(...band.map(cell => cell.y))
      const right = Math.max(...band.map(cell => cell.x)) + 1, bottom = Math.max(...band.map(cell => cell.y)) + 1
      const canvas = document.createElement('canvas')
      canvases.push(canvas)
      canvas.width = right - left; canvas.height = bottom - top
      const context = canvas.getContext('2d')
      if (!context) { stop(); return null }
      for (const { x, y } of band) context.drawImage(sample, x, y, 1, 1, x - left, y - top, 1, 1)
      Object.assign(canvas.style, {
        position: 'absolute', imageRendering: 'pixelated',
        left: `${left / columns * 100}%`, top: `${top / rows * 100}%`,
        width: `${(right - left) / columns * 100}%`, height: `${(bottom - top) / rows * 100}%`,
      })
      layer.append(canvas)
      const animation = canvas.animate([{ opacity: 1 }, { opacity: 1, offset: .18 }, { opacity: 0 }], {
        delay: duration * (.08 + .48 * index / (BANDS - 1)), duration: duration * .44,
        easing: 'cubic-bezier(.22,.61,.36,1)', fill: 'both',
      })
      animations.push(animation)
      // Attach rejection handling immediately: a later band's allocation may fail.
      const completion = animation.finished
      void completion.catch(() => {})
      completions.push(completion)
    }
    sample.width = sample.height = 0
    host.append(layer)
    const finished = Promise.all(completions).then(() => { stop() }, () => { stop() })
    return { finished, stop }
  } catch { stop(); return null }
}
