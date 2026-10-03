const MAX_BACKING_PIXELS = 320_000
const MAX_EDGE = 768

/** One paper study sampled from the decoded work, followed by color and a brief
 * frame glint. The image stays at its original fit; every animated property is
 * opacity or transform. No pixel readback, per-frame paint, or idle effect. */
export function startImageDevelopmentReveal(image: HTMLImageElement, host: HTMLElement, duration: number): { finished: Promise<void>; stop: () => void } | null {
  if (!image.complete || !image.naturalWidth || !image.naturalHeight || typeof image.animate !== 'function') return null
  const rect = image.getBoundingClientRect(), parent = host.getBoundingClientRect()
  if (rect.width < 1 || rect.height < 1 || !Number.isFinite(rect.width * rect.height)) return null
  const fit = Math.min(rect.width / image.naturalWidth, rect.height / image.naturalHeight)
  const width = image.naturalWidth * fit, height = image.naturalHeight * fit
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height), Math.sqrt(MAX_BACKING_PIXELS / (width * height)))
  const draft = document.createElement('canvas')
  draft.width = Math.max(1, Math.floor(width * scale))
  draft.height = Math.max(1, Math.floor(height * scale))
  const layer = document.createElement('div')
  layer.className = 'cg-development-reveal'
  layer.setAttribute('aria-hidden', 'true')
  Object.assign(layer.style, {
    position: 'absolute', pointerEvents: 'none', zIndex: '1', overflow: 'hidden',
    left: `${rect.left - parent.left - host.clientLeft + host.scrollLeft + (rect.width - width) / 2}px`,
    top: `${rect.top - parent.top - host.clientTop + host.scrollTop + (rect.height - height) / 2}px`,
    width: `${width}px`, height: `${height}px`,
  })
  Object.assign(draft.style, { position: 'absolute', inset: '0', width: '100%', height: '100%' })
  const frame = document.createElement('div'), glint = document.createElement('div')
  Object.assign(frame.style, {
    position: 'absolute', inset: '0',
    boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--accent) 60%, #fff8f0)',
  })
  Object.assign(glint.style, {
    position: 'absolute', top: '0', left: '0', width: '30%', height: '1px',
    background: 'linear-gradient(90deg, transparent, #fff8f0, transparent)',
  })
  frame.append(glint)
  layer.append(draft, frame)
  const animations: Animation[] = []
  const completions: Promise<Animation>[] = []
  let disposed = false
  const stop = () => {
    if (disposed) return
    disposed = true
    animations.forEach(animation => animation.cancel())
    layer.remove()
    draft.width = draft.height = 0
  }
  const own = (animation: Animation) => {
    animations.push(animation)
    void animation.finished.catch(() => {})
    completions.push(animation.finished)
  }
  duration = Number.isFinite(duration) ? Math.max(450, Math.min(700, duration)) : 600
  try {
    const context = draft.getContext('2d')
    if (!context) { stop(); return null }
    // Paper is a material inside the artwork, identical in both UI themes.
    // The gray wash is painted once into the bounded bitmap, never animated.
    context.fillStyle = '#f7f2ec'
    context.fillRect(0, 0, draft.width, draft.height)
    context.filter = 'grayscale(1) contrast(.8) brightness(1.2)'
    context.globalAlpha = .38
    context.drawImage(image, 0, 0, draft.width, draft.height)
    context.filter = 'none'
    host.append(layer)
    own(draft.animate([
      { opacity: 1 }, { opacity: 1, offset: .12 },
      { opacity: .64, offset: .4 }, { opacity: 0, offset: .84 }, { opacity: 0 },
    ], { duration, easing: 'linear', fill: 'both' }))
    const originalOpacity = Number.parseFloat(getComputedStyle(image).opacity)
    own(image.animate([
      { opacity: .04 }, { opacity: .12, offset: .12 },
      { opacity: Number.isFinite(originalOpacity) ? originalOpacity : 1, offset: .84 },
      { opacity: Number.isFinite(originalOpacity) ? originalOpacity : 1 },
    ], { duration, easing: 'cubic-bezier(.25,.1,.25,1)', fill: 'both' }))
    own(frame.animate([
      { opacity: 0 }, { opacity: 0, offset: .7 },
      { opacity: .75, offset: .84 }, { opacity: 0 },
    ], { duration, easing: 'linear', fill: 'both' }))
    own(glint.animate([
      { opacity: 0, transform: 'translateX(-100%)' },
      { opacity: .8, offset: .25 },
      { opacity: 0, transform: 'translateX(340%)' },
    ], { delay: duration * .7, duration: duration * .3, easing: 'linear', fill: 'both' }))
    const finished = Promise.all(completions).then(() => { stop() }, () => { stop() })
    return { finished, stop }
  } catch { stop(); return null }
}
