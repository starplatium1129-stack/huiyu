import { createFluidSurface } from '@/composables/useFluidSurface'
import { prefersReducedMotion } from './motionPreference'
import { cssTimeToMilliseconds } from './motionTiming'

/** Native close removes the top layer immediately. Lease only its inert picture
 * to the exit motion, so callers can release focus, media and business state now. */
export function createDialogExit(source: HTMLDialogElement, state: { value: number; velocity: number },
  motion = createFluidSurface(undefined, { animatePanel: true })) {
  if (prefersReducedMotion() || document.hidden) return
  const rect = source.getBoundingClientRect(), style = getComputedStyle(source)
  const matrix = new DOMMatrixReadOnly(style.transform === 'none' ? undefined : style.transform)
  const origin = style.transformOrigin.split(' ').map(parseFloat)
  const backdrop = getComputedStyle(source, '::backdrop')
  const layer = document.createElement('div')
  layer.className = 'fluid-dialog-exit'
  layer.inert = true
  layer.setAttribute('aria-hidden', 'true')
  layer.setAttribute('popover', 'manual')
  const scrim = document.createElement('div')
  scrim.className = 'fluid-dialog-exit-scrim'
  scrim.style.background = backdrop.background
  scrim.style.backdropFilter = backdrop.backdropFilter
  const panel = source.cloneNode(true) as HTMLDialogElement
  panel.setAttribute('open', '')
  panel.removeAttribute('data-fluid-dialog')
  panel.style.cssText += `;position:fixed;inset:auto;margin:0;box-sizing:border-box;left:${rect.left - (1 - matrix.a) * origin[0] - matrix.e}px;top:${rect.top - (1 - matrix.d) * origin[1] - matrix.f}px;width:${rect.width / matrix.a}px;height:${rect.height / matrix.d}px;max-width:none;max-height:none;opacity:1;transform:none;transform-origin:${style.transformOrigin};animation:none;transition:none;`
  // Keep the displayed pixels of canvas viewers without retaining live renderers.
  source.querySelectorAll('canvas').forEach((canvas, index) => {
    const copy = panel.querySelectorAll('canvas')[index]
    if (copy && canvas.width && canvas.height) {
      copy.width = canvas.width; copy.height = canvas.height; copy.getContext('2d')?.drawImage(canvas, 0, 0)
      // cloneNode omits WAAPI presentation, including a still-flying image proxy.
      const current = getComputedStyle(canvas)
      Object.assign(copy.style, { transform: current.transform, clipPath: current.clipPath, opacity: current.opacity })
    }
  })
  for (const element of [panel, ...panel.querySelectorAll('[id]')]) element.removeAttribute('id')
  layer.append(scrim, panel)
  document.body.append(layer)
  const originals = source.querySelectorAll<HTMLElement>('*')
  panel.querySelectorAll<HTMLElement>('*').forEach((copy, index) => {
    copy.scrollTop = originals[index]?.scrollTop ?? 0
    copy.scrollLeft = originals[index]?.scrollLeft ?? 0
  })
  // A manual popover is nonmodal, but remains visible above a parent native dialog.
  layer.showPopover?.()
  // Scrim and panel keep their own presentation; the scrim can already be ahead
  // of the opening spring when the user reverses it.
  const fade = scrim.animate([{ opacity: backdrop.opacity }, { opacity: 0 }], {
    duration: cssTimeToMilliseconds(style.getPropertyValue('--motion-control')),
    easing: style.getPropertyValue('--ease-out').trim(), fill: 'both',
  })
  void fade.finished.catch(() => {})
  const cancel = () => { motion.dispose(panel); fade.cancel(); layer.remove() }
  motion.adopt(panel, state)
  motion.leave(panel, cancel)
  return { capture: () => {
    const current = motion.capture(panel)
    return current ? { ...current, backdrop: Number.parseFloat(getComputedStyle(scrim).opacity) } : undefined
  }, cancel }
}
