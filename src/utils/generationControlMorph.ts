import { prefersReducedMotion } from './motionPreference'

type Morph = { revision: number; animations: Animation[] }
const motions = new WeakMap<HTMLElement, Morph>()

export function cancelGenerationMorph(control: HTMLElement | null) {
  if (!control) return
  const state = motions.get(control)
  if (!state) return
  state.revision++
  const animations = state.animations
  state.animations = []
  for (const animation of animations) { animation.onfinish = animation.oncancel = null; animation.cancel() }
}

/** Measure the currently visible outline before cancelling; settle to the new
 * geometry after Vue patches. The focusable control and task remain synchronous. */
export function captureGenerationMorph(control: HTMLElement | null) {
  const surface = control?.querySelector<HTMLElement>('.generation-action-surface')
  if (!control || !surface) return
  const previous = surface.getBoundingClientRect()
  const radius = getComputedStyle(surface).borderRadius
  const label = control.querySelector<HTMLElement>('.generation-action-label')
  const previousIcon = label?.querySelector<HTMLElement>('.archive-icon')?.getBoundingClientRect()
  cancelGenerationMorph(control)
  const state = motions.get(control) ?? { revision:0, animations:[] }
  motions.set(control, state)
  const revision = ++state.revision
  return () => {
    if (revision !== state.revision || !control.isConnected || document.hidden || prefersReducedMotion() || typeof surface.animate !== 'function') return
    const next = surface.getBoundingClientRect()
    if (!previous.width || !previous.height || !next.width || !next.height) return
    // compositor-exempt: only this bounded outline changes its corner radius,
    // once per task transition; position and size use transform, never layout tweening.
    const animation = surface.animate([
      { transform:`translate(${previous.x-next.x}px,${previous.y-next.y}px) scale(${previous.width/next.width},${previous.height/next.height})`, borderRadius:radius },
      { transform:'none', borderRadius:getComputedStyle(surface).borderRadius },
    ], { duration:280, easing:'cubic-bezier(.22,1,.36,1)' })
    state.animations = [animation]
    const options = { duration:280, easing:'cubic-bezier(.22,1,.36,1)' }
    const icon = label?.querySelector<HTMLElement>('.archive-icon')?.getBoundingClientRect()
    if (label && previousIcon && icon) state.animations.push(label.animate([
      { transform:`translate(${previousIcon.x-icon.x}px,${previousIcon.y-icon.y}px)` }, { transform:'none' },
    ], options))
    for (const part of control.querySelectorAll<HTMLElement>('.generation-track,.generation-percent')) state.animations.push(part.animate([
      { opacity:0, transform:'translateY(-4px)' }, { opacity:1, transform:'none' },
    ], options))
    animation.onfinish = () => {
      if (state.revision !== revision || !state.animations.includes(animation)) return
      cancelGenerationMorph(control)
    }
    animation.oncancel = () => { if (state.animations.includes(animation)) cancelGenerationMorph(control) }
  }
}
