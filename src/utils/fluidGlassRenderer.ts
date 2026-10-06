import { listenMotionChanges, prefersReducedMotion } from './motionPreference'

export const FLUID_GLASS_SELECTOR = '.nav, .nav-more-menu, .sticky-toolbar, .companion-toolbar, .toolbar-shell, .gallery-toolbar, .scene-toolbar, .pop-toolbar, .gen-bar, [data-fluid-glass]'

/** Native backdrop filters paint the material. JS moves one compositor light. */
export function mountFluidGlass(): () => void {
  if (!window.CSS?.supports('backdrop-filter', 'blur(1px)')) return () => {}
  let active: { element: HTMLElement; layer: HTMLElement; light: HTMLElement; box: DOMRect; positioned: boolean } | undefined
  let frame = 0, x = 0, y = 0, pressed = false
  function clear() {
    cancelAnimationFrame(frame); frame = 0; pressed = false
    if (!active) return
    active.layer.remove()
    active.element.classList.remove('fluid-glass-lit')
    if (active.positioned) active.element.classList.remove('fluid-glass-positioned')
    active = undefined
  }
  function surface(target: EventTarget | null) {
    const element = target instanceof Element ? target.closest(FLUID_GLASS_SELECTOR) : null
    return element instanceof HTMLElement ? element : undefined
  }
  function enter(element: HTMLElement) {
    if (active?.element === element) return
    clear()
    const layer = document.createElement('div'), light = document.createElement('div')
    layer.className = 'fluid-glass-optics'; layer.setAttribute('aria-hidden', 'true')
    light.className = 'fluid-glass-sheen'; layer.append(light)
    const positioned = getComputedStyle(element).position === 'static'
    if (positioned) element.classList.add('fluid-glass-positioned')
    element.classList.add('fluid-glass-lit')
    element.prepend(layer)
    active = { element, layer, light, positioned, box: element.getBoundingClientRect() }
  }
  function present() {
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      if (!active?.element.isConnected) { clear(); return }
      const { box, light } = active
      light.style.transform = `translate3d(calc(-50% + ${x - box.left - box.width / 2}px),calc(-50% + ${y - box.top - box.height / 2}px),0)`
      light.style.opacity = pressed ? '.18' : '.10'
    })
  }
  function move(event: PointerEvent) {
    if (event.pointerType === 'touch' || prefersReducedMotion()) return
    const element = surface(event.target)
    if (!element) { clear(); return }
    enter(element); x = event.clientX; y = event.clientY; present()
  }
  function press(event: PointerEvent) {
    move(event)
    if (active) { pressed = true; present() }
  }
  function release() { pressed = false; if (active) present() }
  function leave(event: PointerEvent) { if (!event.relatedTarget) clear() }
  function key(event: KeyboardEvent) {
    if (event.repeat || prefersReducedMotion() || !['Enter', ' '].includes(event.key) || !(event.target instanceof Element)
      || !event.target.closest('button,a,[role="button"],[role="tab"],[role="radio"]')) return
    const element = surface(event.target)
    if (!element) return
    enter(element); x = active!.box.left + active!.box.width / 2; y = active!.box.top + active!.box.height / 2
    pressed = true; present()
  }
  const stopMotion = listenMotionChanges(() => { if (prefersReducedMotion()) clear() })
  document.addEventListener('pointermove', move, { passive: true })
  document.addEventListener('pointerdown', press, { passive: true })
  document.addEventListener('pointerout', leave, { passive: true })
  document.addEventListener('keydown', key)
  window.addEventListener('pointerup', release)
  window.addEventListener('pointercancel', clear)
  window.addEventListener('keyup', release)
  window.addEventListener('scroll', clear, { passive: true, capture: true })
  window.addEventListener('resize', clear)
  window.addEventListener('blur', clear)
  return () => {
    clear(); stopMotion()
    document.removeEventListener('pointermove', move); document.removeEventListener('pointerdown', press)
    document.removeEventListener('pointerout', leave); document.removeEventListener('keydown', key)
    window.removeEventListener('pointerup', release); window.removeEventListener('pointercancel', clear)
    window.removeEventListener('keyup', release); window.removeEventListener('scroll', clear, true)
    window.removeEventListener('resize', clear); window.removeEventListener('blur', clear)
  }
}
