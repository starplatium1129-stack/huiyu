import { getCurrentInstance, onDeactivated, onUnmounted } from 'vue'
import { prefersReducedMotion } from '@/utils/motionPreference'
import { FluidSpring } from '@/utils/fluidSpring'
import { cssTimeToMilliseconds } from '@/utils/motionTiming'

type ImageRect = { left: number; top: number; width: number; height: number }
type Origin = { rect: ImageRect; src: string; clipPath?: string }
const UNCLIPPED = 'inset(0% 0% 0% 0%)'
type Flight = {
  proxy: HTMLCanvasElement
  target: HTMLImageElement
  host: HTMLElement
  restore: () => void
  animation: Animation | null
  clipped: boolean
  settle: (() => void) | null
  trajectory: { from: number[]; to: number[]; velocity: number[]; frequency: number } | null
}

function imageRect(image: HTMLImageElement): ImageRect {
  const box = image.getBoundingClientRect()
  const rect = { left: box.left, top: box.top, width: box.width, height: box.height }
  if (getComputedStyle(image).objectFit === 'contain' && image.naturalWidth && image.naturalHeight) {
    const fit = Math.min(rect.width / image.naturalWidth, rect.height / image.naturalHeight)
    const width = image.naturalWidth * fit, height = image.naturalHeight * fit
    rect.left += (rect.width - width) / 2; rect.top += (rect.height - height) / 2
    rect.width = width; rect.height = height
  }
  return rect
}

function safeOrigin(image: HTMLImageElement | null): Origin | null {
  if (!image?.isConnected || !image.complete || !image.naturalWidth) return null
  // Never turn a blurred/restricted thumbnail into an unfiltered floating copy.
  for (let node: HTMLElement | null = image; node; node = node.parentElement) {
    const style = getComputedStyle(node)
    if (style.filter && style.filter !== 'none' || style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity || 1) === 0) return null
  }
  const fullRect = imageRect(image), rect = { ...fullRect }
  // Keep both the painted image mapping and its aperture. Shrinking the image
  // into the visible rectangle would reveal cropped edge pixels at handoff.
  for (let node = image.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node), box = node.getBoundingClientRect()
    if (/(hidden|clip|auto|scroll)/.test(style.overflowX || style.overflow)) {
      const right = Math.min(rect.left + rect.width, box.right)
      rect.left = Math.max(rect.left, box.left); rect.width = Math.max(0, right - rect.left)
    }
    if (/(hidden|clip|auto|scroll)/.test(style.overflowY || style.overflow)) {
      const bottom = Math.min(rect.top + rect.height, box.bottom)
      rect.top = Math.max(rect.top, box.top); rect.height = Math.max(0, bottom - rect.top)
    }
  }
  if (!rect.width || !rect.height || rect.left >= innerWidth || rect.top >= innerHeight || rect.left + rect.width <= 0 || rect.top + rect.height <= 0) return null
  const insets = [rect.top - fullRect.top, fullRect.left + fullRect.width - rect.left - rect.width,
    fullRect.top + fullRect.height - rect.top - rect.height, rect.left - fullRect.left]
  const clipPath = insets.some(value => value > 0)
    ? `inset(${insets.map((value, index) => `${Number((100 * value / (index % 2 ? fullRect.width : fullRect.height)).toFixed(6))}%`).join(' ')})` : undefined
  return { rect: fullRect, src: image.currentSrc || image.src, clipPath }
}

function visibleTarget(rect: ImageRect, image: HTMLImageElement, host: HTMLElement) {
  const right = rect.left + rect.width, bottom = rect.top + rect.height
  if (rect.left < 0 || rect.top < 0 || right > innerWidth + 1 || bottom > innerHeight + 1) return false
  for (let parent = image.parentElement; parent && parent !== host; parent = parent.parentElement) {
    const style = getComputedStyle(parent), box = parent.getBoundingClientRect()
    if (/(hidden|clip|auto|scroll)/.test(style.overflowX || style.overflow) && (rect.left < box.left - 1 || right > box.right + 1)) return false
    if (/(hidden|clip|auto|scroll)/.test(style.overflowY || style.overflow) && (rect.top < box.top - 1 || bottom > box.bottom + 1)) return false
  }
  return true
}

/** A bounded, reversible image flight; native/Fluid dialog keeps owning focus and opacity. */
export function useImageOriginTransition(options: { proxyPixelBudget: number }) {
  let origin: Origin | null = null
  let capturedAt = 0
  let flight: Flight | null = null
  let revision = 0
  function clearFlight() {
    const old = flight; flight = null
    if (!old) return
    old.animation?.cancel()
    old.settle?.(); old.settle = null
    old.restore(); old.proxy.remove()
    old.proxy.width = old.proxy.height = 0
  }
  function cancel() {
    revision++
    clearFlight()
  }
  function capture(sourceImg: HTMLImageElement | null) {
    origin = safeOrigin(sourceImg); capturedAt = performance.now()
    return origin?.src || ''
  }

  async function move(direction: 'enter' | 'leave', target: HTMLImageElement, host: HTMLElement, sourceImg?: HTMLImageElement | null) {
    const startedAt = performance.now()
    const enterDeadline = capturedAt + 180
    const token = ++revision
    if (direction === 'leave' && sourceImg !== undefined) origin = safeOrigin(sourceImg)
    const source = origin
    if (!source || prefersReducedMotion() || document.hidden || !target.isConnected || typeof target.animate !== 'function') { clearFlight(); return }
    if (direction === 'enter' && flight?.target !== target) {
      const remaining = enterDeadline - performance.now()
      // The bounded canvas path copies a warm image synchronously, before
      // the owning dialog's enter hook yields. Never wait for decode here:
      // that can hide a viewer image which has already become visible.
      const warm = target.complete && target.naturalWidth > 0
      if (remaining <= 0 || !warm) { clearFlight(); return }
    }
    if (!target.isConnected || !host.isConnected) { clearFlight(); return }
    const destination = imageRect(target)
    if (!destination.width || !destination.height || !target.naturalWidth) { clearFlight(); return }
    // A zoomed/cropped image must not reveal pixels outside its current viewport,
    // and unrelated thumbnail crops must not stretch into a different aspect ratio.
    if (!visibleTarget(destination, target, host) || Math.abs((source.rect.width / source.rect.height) / (destination.width / destination.height) - 1) > .02) { clearFlight(); return }
    const copiedProxy = host.querySelector<HTMLCanvasElement>('[data-image-origin-proxy]')
    if (direction === 'leave' && flight && flight.host !== host && copiedProxy
      && (target.currentSrc || target.src) === (flight.target.currentSrc || flight.target.src)) {
      // Native close leases a visual clone. Move the live flight into that lease
      // so an early reversal retains its pixels, position and velocity exactly.
      copiedProxy.remove(); copiedProxy.width = copiedProxy.height = 0
      flight.restore()
      const opacity = target.style.opacity, transition = target.style.transition
      target.style.transition = 'none'; target.style.opacity = '0'
      host.append(flight.proxy)
      flight.target = target; flight.host = host
      flight.restore = () => { target.style.opacity = opacity; target.style.transition = transition }
    }
    let from = direction === 'enter' ? source.rect : destination
    let velocity = [0, 0, 0, 0]
    let clipped = Boolean(source.clipPath)
    let fromClip = direction === 'enter' ? source.clipPath || UNCLIPPED : UNCLIPPED
    if (flight?.target === target && flight.host === host) {
      from = flight.proxy.getBoundingClientRect()
      if (flight.trajectory) {
        const path = flight.trajectory, elapsed = Math.max(0, Number(flight.animation?.currentTime) || 0) / 1000
        const axes = path.from.map((value, index) => {
          const axis = new FluidSpring(value, path.frequency)
          axis.velocity = path.velocity[index]; axis.to(path.to[index]); axis.step(elapsed)
          return axis
        })
        from = { left: axes[0].value, top: axes[1].value, width: axes[2].value, height: axes[3].value }
        velocity = axes.map(axis => axis.velocity)
      }
      clipped ||= flight.clipped
      if (clipped) {
        const currentClip = getComputedStyle(flight.proxy).clipPath
        fromClip = currentClip && currentClip !== 'none' ? currentClip : UNCLIPPED
      }
      flight.animation?.cancel(); flight.animation = null
      flight.settle?.(); flight.settle = null
    } else {
      clearFlight()
      // Copy only the warm frame's display pixels so a 4K original does not
      // create another full-size animated image texture.
      const proxy = document.createElement('canvas')
      const scale = Math.min(window.devicePixelRatio || 1,
        Math.sqrt(options.proxyPixelBudget / (destination.width * destination.height)),
        target.naturalWidth / destination.width, target.naturalHeight / destination.height)
      proxy.width = Math.max(1, Math.floor(destination.width * scale))
      proxy.height = Math.max(1, Math.floor(destination.height * scale))
      try {
        const context = proxy.getContext('2d')
        if (!context || !target.complete) { proxy.width = proxy.height = 0; return }
        context.drawImage(target, 0, 0, proxy.width, proxy.height)
      } catch { proxy.width = proxy.height = 0; return }
      proxy.setAttribute('aria-hidden', 'true')
      proxy.setAttribute('data-image-origin-proxy', '')
      from = direction === 'enter' ? source.rect : destination
      Object.assign(proxy.style, {
        position: 'fixed', inset: '0 auto auto 0', display: 'block', margin: '0', border: '0',
        width: `${destination.width}px`, height: `${destination.height}px`, maxWidth: 'none', maxHeight: 'none',
        objectFit: 'fill', transformOrigin: '0 0', pointerEvents: 'none', zIndex: 'var(--z-overlay)',
        borderRadius: getComputedStyle(target).borderRadius,
      })
      const opacity = target.style.opacity, transition = target.style.transition
      target.style.transition = 'none'; target.style.opacity = '0'
      host.append(proxy)
      flight = { proxy, target, host, animation: null, clipped: false, settle: null, trajectory: null, restore: () => {
        target.style.opacity = opacity
        // Commit restoration before reenabling an image's loading fade.
        void getComputedStyle(target).opacity
        target.style.transition = transition
      } }
    }
    const active = flight!
    const to = direction === 'enter' ? destination : source.rect
    const width = Number.parseFloat(active.proxy.style.width), height = Number.parseFloat(active.proxy.style.height)
    const transform = (rect: ImageRect) => `translate(${rect.left}px, ${rect.top}px) scale(${rect.width / width}, ${rect.height / height})`
    active.proxy.dataset.imageOriginDirection = direction
    active.clipped = clipped
    const style = getComputedStyle(host)
    const duration = Math.max(1, cssTimeToMilliseconds(style.getPropertyValue(direction === 'enter' ? '--motion-route-cut' : '--motion-route'))
      - (direction === 'leave' ? performance.now() - startedAt : 0))
    const frequency = direction === 'enter' ? 4.6 : 5.2
    const values = (rect: ImageRect) => [rect.left, rect.top, rect.width, rect.height]
    active.trajectory = { from: values(from), to: values(to), velocity, frequency }
    await new Promise<void>(resolve => {
      active.settle = resolve
      try {
        const axes = values(from).map((value, index) => {
          const axis = new FluidSpring(value, frequency)
          axis.velocity = velocity[index]; axis.to(values(to)[index]); return axis
        })
        const steps = Math.max(1, Math.ceil(duration / (1000 / 60)))
        const frames: Keyframe[] = [{ transform: transform(from) }]
        for (let step = 1; step <= steps; step++) {
          axes.forEach(axis => axis.step(duration / steps / 1000))
          const rect = { left: axes[0].value, top: axes[1].value, width: axes[2].value, height: axes[3].value }
          frames.push({ transform: transform(step === steps ? to : rect) })
        }
        if (clipped) {
          /* compositor-exempt: one bounded image-flight aperture preserves the actual thumbnail crop; no persistent layer or loop. */
          frames[0].clipPath = fromClip
          frames[frames.length - 1].clipPath = direction === 'enter' ? UNCLIPPED : source.clipPath || UNCLIPPED
        }
        const animation = active.proxy.animate(frames, {
          duration, easing: 'linear', fill: 'both',
        })
        active.animation = animation
        void animation.finished.then(() => {
          if (token !== revision || flight !== active) return
          active.settle?.(); active.settle = null
          // Keep the collapsed image until the owning dialog finishes its fade.
          if (direction === 'enter') clearFlight()
        }, () => { resolve(); if (active.settle === resolve) active.settle = null })
      } catch { if (flight === active) clearFlight(); else resolve() }
    })
  }

  const preference = () => { if (prefersReducedMotion() || document.hidden) cancel() }
  const media = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null
  media?.addEventListener?.('change', preference)
  document.addEventListener('visibilitychange', preference)
  window.addEventListener('atelier:motion-preference', preference)
  const dispose = () => {
    cancel(); origin = null
    media?.removeEventListener?.('change', preference)
    document.removeEventListener('visibilitychange', preference)
    window.removeEventListener('atelier:motion-preference', preference)
  }
  if (getCurrentInstance()) { onDeactivated(cancel); onUnmounted(dispose) }
  return {
    capture,
    enter: (targetImg: HTMLImageElement, host: HTMLElement) => move('enter', targetImg, host),
    leave: (targetImg: HTMLImageElement, host: HTMLElement, sourceImg?: HTMLImageElement | null) => move('leave', targetImg, host, sourceImg),
    cancel,
  }
}
