import { getCurrentInstance, onDeactivated, onUnmounted } from 'vue'
import { prefersReducedMotion } from '@/utils/motionPreference'

type ImageRect = { left: number; top: number; width: number; height: number }
type Origin = { rect: ImageRect; src: string }
type Flight = {
  proxy: HTMLImageElement
  target: HTMLImageElement
  host: HTMLElement
  restore: () => void
  animation: Animation | null
  settle: (() => void) | null
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
  const rect = imageRect(image)
  if (!rect.width || !rect.height || rect.left >= innerWidth || rect.top >= innerHeight || rect.left + rect.width <= 0 || rect.top + rect.height <= 0) return null
  return { rect, src: image.currentSrc || image.src }
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
export function useImageOriginTransition() {
  let origin: Origin | null = null
  let capturedAt = 0
  let flight: Flight | null = null
  let revision = 0
  let stopWaiting: (() => void) | null = null
  let pendingProxy: HTMLImageElement | null = null

  function clearPendingProxy() {
    const image = pendingProxy; pendingProxy = null
    image?.removeAttribute('src')
  }

  function clearFlight() {
    const old = flight; flight = null
    if (!old) return
    old.animation?.cancel()
    old.settle?.(); old.settle = null
    old.restore(); old.proxy.remove()
  }
  function cancel() {
    revision++
    stopWaiting?.(); stopWaiting = null
    clearPendingProxy()
    clearFlight()
  }
  function capture(sourceImg: HTMLImageElement | null) {
    origin = safeOrigin(sourceImg); capturedAt = performance.now()
    return origin?.src || ''
  }

  function ready(image: HTMLImageElement, timeout: number): Promise<boolean> {
    return new Promise(resolve => {
      let settled = false
      const finish = (value: boolean) => {
        if (settled) return
        settled = true; clearTimeout(timer)
        image.removeEventListener('load', loaded); image.removeEventListener('error', failed)
        if (stopWaiting === stopped) stopWaiting = null
        resolve(value)
      }
      const loaded = () => {
        if (!image.naturalWidth) return finish(false)
        if (typeof image.decode !== 'function') return finish(true)
        try { void image.decode().then(() => finish(image.complete && image.naturalWidth > 0), () => finish(false)) }
        catch { finish(false) }
      }
      const failed = () => finish(false), stopped = () => finish(false)
      const timer = setTimeout(() => finish(false), timeout)
      stopWaiting = stopped
      if (image.complete) loaded()
      else { image.addEventListener('load', loaded, { once: true }); image.addEventListener('error', failed, { once: true }) }
    })
  }

  async function move(direction: 'enter' | 'leave', target: HTMLImageElement, host: HTMLElement, sourceImg?: HTMLImageElement | null) {
    const startedAt = performance.now()
    const enterDeadline = capturedAt + 180
    const token = ++revision
    stopWaiting?.(); stopWaiting = null
    clearPendingProxy()
    if (direction === 'leave' && sourceImg !== undefined) origin = safeOrigin(sourceImg)
    const source = origin
    if (!source || prefersReducedMotion() || document.hidden || !target.isConnected || typeof target.animate !== 'function') { clearFlight(); return }
    if (direction === 'enter' && flight?.target !== target) {
      const remaining = enterDeadline - performance.now()
      if (remaining <= 0 || !await ready(target, remaining)) { if (token === revision) clearFlight(); return }
    }
    if (token !== revision) return
    if (!target.isConnected || !host.isConnected) { clearFlight(); return }
    let destination = imageRect(target)
    if (!destination.width || !destination.height || !target.naturalWidth) { clearFlight(); return }
    // A zoomed/cropped image must not reveal pixels outside its current viewport,
    // and unrelated thumbnail crops must not stretch into a different aspect ratio.
    if (!visibleTarget(destination, target, host) || Math.abs((source.rect.width / source.rect.height) / (destination.width / destination.height) - 1) > .02) { clearFlight(); return }
    let from = direction === 'enter' ? source.rect : destination
    if (flight?.target === target && flight.host === host) {
      from = flight.proxy.getBoundingClientRect()
      flight.animation?.cancel(); flight.animation = null
      flight.settle?.(); flight.settle = null
    } else {
      clearFlight()
      const proxy = document.createElement('img')
      pendingProxy = proxy
      // The desktop gateway requires the same CORS provenance as the real image.
      // Set request attributes before src; a decoded target does not make a new
      // no-CORS request safe or guarantee that the proxy itself can be decoded.
      if (target.crossOrigin !== null) proxy.crossOrigin = target.crossOrigin
      proxy.referrerPolicy = target.referrerPolicy
      proxy.decoding = 'async'; proxy.loading = 'eager'
      proxy.alt = ''; proxy.setAttribute('aria-hidden', 'true')
      proxy.setAttribute('data-image-origin-proxy', '')
      const requestSrc = target.currentSrc || target.src || source.src
      proxy.src = requestSrc
      // Leaving cannot delay the owning 300ms fade. A cache miss gets a plain
      // fade; successful decode time is also deducted from the 280ms flight.
      const remaining = direction === 'enter' ? enterDeadline - performance.now() : 20 - (performance.now() - startedAt)
      const decoded = remaining > 0 && await ready(proxy, remaining)
      if (pendingProxy === proxy) pendingProxy = null
      if (!decoded || token !== revision || !target.isConnected || !host.isConnected || (target.currentSrc || target.src) !== requestSrc) {
        proxy.removeAttribute('src')
        if (token === revision) clearFlight()
        return
      }
      destination = imageRect(target)
      if (!destination.width || !destination.height || !visibleTarget(destination, target, host)
        || Math.abs((source.rect.width / source.rect.height) / (destination.width / destination.height) - 1) > .02) {
        proxy.removeAttribute('src'); return
      }
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
      flight = { proxy, target, host, animation: null, settle: null, restore: () => {
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
    await new Promise<void>(resolve => {
      active.settle = resolve
      try {
        const animation = active.proxy.animate([{ transform: transform(from) }, { transform: transform(to) }], {
          duration: direction === 'leave' ? Math.max(0, 280 - (performance.now() - startedAt)) : 280,
          easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'both',
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
