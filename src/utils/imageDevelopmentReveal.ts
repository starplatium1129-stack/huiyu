/** A brief original-image fade and frame glint. The artwork remains sharp
 * throughout; no low-resolution image surface replaces the decoded original. */
export function startImageDevelopmentReveal(image: HTMLImageElement, host: HTMLElement, duration: number): { finished: Promise<void>; stop: () => void } | null {
  if (!image.complete || !image.naturalWidth || !image.naturalHeight || typeof image.animate !== 'function') return null
  const rect = image.getBoundingClientRect(), parent = host.getBoundingClientRect()
  if (rect.width < 1 || rect.height < 1 || !Number.isFinite(rect.width * rect.height)) return null
  const fit = Math.min(rect.width / image.naturalWidth, rect.height / image.naturalHeight)
  const width = image.naturalWidth * fit, height = image.naturalHeight * fit
  const layer = document.createElement('div')
  layer.className = 'cg-development-reveal'
  layer.setAttribute('aria-hidden', 'true')
  Object.assign(layer.style, {
    position: 'absolute', pointerEvents: 'none', zIndex: '1', overflow: 'hidden',
    left: `${rect.left - parent.left - host.clientLeft + host.scrollLeft + (rect.width - width) / 2}px`,
    top: `${rect.top - parent.top - host.clientTop + host.scrollTop + (rect.height - height) / 2}px`,
    width: `${width}px`, height: `${height}px`,
  })
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
  layer.append(frame)
  const animations: Animation[] = []
  const completions: Promise<Animation>[] = []
  let disposed = false
  const stop = () => {
    if (disposed) return
    disposed = true
    animations.forEach(animation => animation.cancel())
    layer.remove()
  }
  const own = (animation: Animation) => {
    animations.push(animation)
    void animation.finished.catch(() => {})
    completions.push(animation.finished)
  }
  duration = Number.isFinite(duration) ? Math.max(450, Math.min(700, duration)) : 600
  try {
    host.append(layer)
    const originalOpacity = Number.parseFloat(getComputedStyle(image).opacity)
    own(image.animate([
      { opacity: 0 },
      { opacity: Number.isFinite(originalOpacity) ? originalOpacity : 1 },
    ], { duration: Math.min(duration, 450), easing: 'cubic-bezier(.22,1,.36,1)', fill: 'both' }))
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
