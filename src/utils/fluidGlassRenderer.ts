import { listenMotionChanges, prefersReducedMotion } from './motionPreference'
import { mountFluidGlassOptics } from './fluidGlassOptics'

// Match floating glass chrome only; inline segmented controls stay clean inside panels.
const FLUID_GLASS_SELECTOR = '.nav, .nav-more-menu, .companion-toolbar, [data-fluid-glass]:where(:not(.gallery-toolbar *, .browse-toolbar *, .studio-segments))'
const lights = new WeakMap<HTMLElement, { layer: HTMLElement; light: HTMLElement }>()

/** Native backdrop filters paint the material. JS moves one compositor light. */
export function mountFluidGlass() {
  if (!window.CSS?.supports('backdrop-filter', 'blur(1px)')) return
  const stopOptics = mountFluidGlassOptics()
  const root = document.documentElement
  let surfaceTarget: HTMLElement | undefined, lit: HTMLElement | undefined, box: DOMRect | undefined
  let frame = 0, x = 0, y = 0, pressed = false, centered = false, paused = false
  let scrollTimer: ReturnType<typeof setTimeout> | undefined
  function clear() {
    cancelAnimationFrame(frame); frame = 0; pressed = centered = false
    if (lit) lights.get(lit)?.light.style.removeProperty('opacity')
    lit = surfaceTarget = box = undefined
  }
  function surface(target: EventTarget | null) {
    const element = target instanceof Element ? target.closest(FLUID_GLASS_SELECTOR) : null
    return element instanceof HTMLElement ? element : undefined
  }
  function createLight(element: HTMLElement, needsPosition: boolean) {
    const layer = document.createElement('div'), light = document.createElement('div')
    layer.className = 'fluid-glass-optics'; layer.setAttribute('aria-hidden', 'true')
    light.className = 'fluid-glass-sheen'; layer.append(light)
    if (needsPosition) element.classList.add('fluid-glass-positioned')
    element.classList.add('fluid-glass-lit')
    element.prepend(layer)
    const entry = { layer, light }
    lights.set(element, entry)
    return entry
  }
  function present() {
    if (frame || paused) return
    frame = requestAnimationFrame(() => {
      frame = 0
      const element = surfaceTarget
      if (!element?.isConnected) { clear(); return }
      box ??= element.getBoundingClientRect()
      if (!centered && (x < box.left || x > box.right || y < box.top || y > box.bottom)) { clear(); return }
      const existing = lights.get(element)
      const needsPosition = existing?.layer.parentElement !== element && getComputedStyle(element).position === 'static'
      // Do every layout read before writing or attaching the first light.
      if (lit && lit !== element) lights.get(lit)?.light.style.removeProperty('opacity')
      const { light } = existing?.layer.parentElement === element ? existing : createLight(element, needsPosition)
      lit = element
      const dx = centered ? 0 : x - box.left - box.width / 2
      const dy = centered ? 0 : y - box.top - box.height / 2
      const scale = pressed ? ' scale(1.12)' : ''
      light.style.transform = `translate3d(calc(-50% + ${dx}px),calc(-50% + ${dy}px),0)${scale}`
      light.style.opacity = pressed ? '.36' : '.22'
    })
  }
  function move(event: PointerEvent) {
    if (paused || event.pointerType === 'touch' || prefersReducedMotion()) return
    const element = surface(event.target)
    if (!element) { clear(); return }
    if (surfaceTarget !== element) { surfaceTarget = element; box = undefined }
    centered = false; x = event.clientX; y = event.clientY; present()
  }
  function press(event: PointerEvent) {
    move(event)
    if (surfaceTarget) { pressed = true; present() }
  }
  function release() { if (centered) clear(); else { pressed = false; if (surfaceTarget) present() } }
  function leave(event: PointerEvent) { if (!event.relatedTarget) clear() }
  function key(event: KeyboardEvent) {
    if (paused || event.repeat || prefersReducedMotion() || !['Enter', ' '].includes(event.key) || !(event.target instanceof Element)
      || !event.target.closest('button,a,[role="button"],[role="tab"],[role="radio"]')) return
    const element = surface(event.target)
    if (!element) return
    if (surfaceTarget !== element) { surfaceTarget = element; box = undefined }
    centered = pressed = true; present()
  }
  function refreshGeometry() { box = undefined; if (surfaceTarget) present() }
  function stopScrolling() {
    clearTimeout(scrollTimer); scrollTimer = undefined
    delete root.dataset.glassScrolling
  }
  function scroll() {
    if (paused) return
    refreshGeometry()
    if (scrollTimer === undefined) root.dataset.glassScrolling = ''
    else clearTimeout(scrollTimer)
    scrollTimer = setTimeout(stopScrolling, 140)
  }
  const stopMotion = listenMotionChanges(() => { if (prefersReducedMotion()) clear() })
  document.addEventListener('pointermove', move, { passive: true })
  document.addEventListener('pointerdown', press, { passive: true })
  document.addEventListener('pointerout', leave, { passive: true })
  document.addEventListener('keydown', key)
  window.addEventListener('pointerup', release)
  window.addEventListener('pointercancel', clear)
  window.addEventListener('keyup', release)
  window.addEventListener('scroll', scroll, { passive: true, capture: true })
  window.addEventListener('resize', refreshGeometry)
  window.addEventListener('blur', clear)
  return {
    setPaused(value: boolean) {
      paused = value
      if (value) { clear(); stopScrolling() }
      stopOptics.setPaused(value)
    },
    stop() {
      clear(); stopScrolling(); stopMotion(); stopOptics.stop()
      document.removeEventListener('pointermove', move); document.removeEventListener('pointerdown', press)
      document.removeEventListener('pointerout', leave); document.removeEventListener('keydown', key)
      window.removeEventListener('pointerup', release); window.removeEventListener('pointercancel', clear)
      window.removeEventListener('keyup', release); window.removeEventListener('scroll', scroll, true)
      window.removeEventListener('resize', refreshGeometry); window.removeEventListener('blur', clear)
    },
  }
}
