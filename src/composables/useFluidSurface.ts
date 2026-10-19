import { onDeactivated, onUnmounted } from 'vue'
import { createFluidMotion, FluidSpring } from '@/utils/fluidSpring'
import { listenMotionChanges, prefersReducedMotion } from '@/utils/motionPreference'
import { cssTimeToMilliseconds } from '@/utils/motionTiming'
import { SURFACE_DAMPING, SURFACE_FREQUENCY } from '@/utils/controlSprings'

/** 全屏与超大图查看器类名清单 */
const FLUID_FULLSCREEN_SELECTORS = [
  '.art-viewer',
  '.candidate-compare',
  '.pb-compare',
  '.inpaint-modal',
] as const

const FLUID_FULLSCREEN_SELECTOR = FLUID_FULLSCREEN_SELECTORS.join(', ')

/** Sample the existing spring once; native timelines keep fading while a newly
 * opened form lays out. Retarget from presentation and retain spring velocity. */
type Presentation = { value: number; velocity: number; opacity?: number; opacityVelocity?: number; backdrop?: number }
export type SurfaceLayers = (el: HTMLElement, opacity: { opacity: number }[], timing: KeyframeAnimationOptions,
  target: number, add: (animation: Animation) => void) => void
type SurfaceOptions = { animatePanel?: boolean; small?: boolean; layers?: SurfaceLayers }

function compositedMotion(el: HTMLElement, panel: HTMLElement, initial: Presentation, frequency: number, damping: number,
  transform: ((progress: number) => string) | undefined, write: (progress: number, backdrop?: boolean, opacity?: number) => void,
  layered?: SurfaceLayers,
) {
  const spring = new FluidSpring(initial.value, frequency, damping)
  spring.velocity = initial.velocity
  // Alpha never oscillates: a closing spring can cross zero and rebound without
  // briefly revealing the departing text again. Both channels survive reversal.
  const alpha = new FluidSpring(initial.opacity ?? Math.max(0, Math.min(1, initial.value)), damping < 1 ? 8 : frequency)
  alpha.velocity = initial.opacityVelocity ?? (damping < 1 ? 0 : initial.velocity)
  let effects: Animation[] = [], origin = { ...initial, opacity: alpha.value, opacityVelocity: alpha.velocity }
  let done: (() => void) | undefined, version = 0, active = false, disposed = false
  let fallback: ReturnType<typeof createFluidMotion> | null = null
  const cancel = () => { for (const effect of effects.splice(0)) effect.cancel() }
  const finish = () => {
    if (!active || disposed) return
    active = false; spring.snap(); alpha.snap(); write(spring.value, true, alpha.value)
    const callback = done; done = undefined; cancel(); callback?.()
  }
  const stopPreference = listenMotionChanges(() => { if (document.hidden || prefersReducedMotion()) finish() })
  const capture = () => {
    if (active && effects[0]) {
      spring.value = origin.value; spring.velocity = origin.velocity
      alpha.value = origin.opacity; alpha.velocity = origin.opacityVelocity
      const elapsed = Math.max(0, Number(effects[0].currentTime) || 0) / 1000
      spring.step(elapsed); alpha.step(elapsed)
    }
    return { value: spring.value, velocity: spring.velocity, opacity: alpha.value, opacityVelocity: alpha.velocity }
  }
  return {
    capture,
    to(targets: number[], instant = false, callback?: () => void) {
      if (disposed) return
      if (fallback) { fallback.to([targets[0], targets[0]], instant, callback); return }
      const backdropOpacity = active && el instanceof HTMLDialogElement ? getComputedStyle(el, '::backdrop').opacity : String(initial.backdrop ?? spring.value)
      capture()
      version++; const token = version
      if (instant) done?.()
      cancel(); done = callback; active = true; spring.to(targets[0]); alpha.to(targets[0])
      write(spring.value, false, alpha.value)
      if (instant || document.hidden || prefersReducedMotion()) { finish(); return }
      origin = { value: spring.value, velocity: spring.velocity, opacity: alpha.value, opacityVelocity: alpha.velocity }
      const sample = new FluidSpring(spring.value, frequency, damping)
      sample.velocity = spring.velocity; sample.to(spring.target)
      const fade = new FluidSpring(alpha.value, alpha.frequency)
      fade.velocity = alpha.velocity; fade.to(alpha.target)
      const progress = [sample.value]
      const opacity = [{ opacity: fade.value }]
      for (let frame = 0; frame < 120 && (!sample.settled || !fade.settled); frame++) {
        progress.push(sample.step(1 / 60)); opacity.push({ opacity: fade.step(1 / 60) })
      }
      const transforms = transform ? progress.map(value => ({ transform: transform(value) })) : null
      const timing = { duration: Math.max(1, (progress.length - 1) * 1000 / 60), fill: 'both' as const, easing: 'linear' }
      try {
        const root = el.animate(panel === el && transforms ? opacity.map((value, index) => ({ ...value, ...transforms[index] })) : opacity,
          layered ? { ...timing, pseudoElement: '::before' } : timing)
        effects.push(root)
        layered?.(el, opacity, timing, targets[0], animation => { effects.push(animation) })
        if (panel !== el && transforms) effects.push(panel.animate(transforms, timing))
        if (el instanceof HTMLDialogElement) {
          // Inspira UI AnimatedModal separates scrim fading from panel motion.
          // Adapted from 04c57ab62b9713872ebbf68988dff1836ed3d764; MIT notice: assets/licenses/inspira-ui.txt.
          const style = getComputedStyle(el)
          effects.push(el.animate([{ opacity: backdropOpacity }, { opacity: spring.target }], {
            ...timing, duration: cssTimeToMilliseconds(style.getPropertyValue('--motion-control')),
            easing: style.getPropertyValue('--ease-out').trim(), pseudoElement: '::backdrop',
          }))
        }
        for (const effect of effects) void effect.finished.catch(() => {})
        void root.finished.then(() => { if (token === version) finish() }, () => { if (token === version) finish() })
      } catch {
        version++; active = false; done = undefined; cancel()
        fallback = createFluidMotion([spring.value, alpha.value], ([value, opacity]) => {
          spring.value = value; alpha.value = opacity; spring.velocity = alpha.velocity = 0
          write(value, true, opacity)
        }, frequency)
        fallback.to([targets[0], targets[0]], instant, callback)
      }
    },
    settle() { if (fallback) fallback.settle(); else finish() },
    dispose() { disposed = true; active = false; version++; done = undefined; cancel(); fallback?.dispose(); stopPreference() },
  }
}

/** Vue Transition hooks: v-show keeps the same physical surface during reversal. */
export function createFluidSurface(panelSelector?: string, options: SurfaceOptions = {}) {
  type Surface = { motion: ReturnType<typeof compositedMotion>; restore: () => void }
  const motions = new Map<HTMLElement, Surface>()
  function surface(el: HTMLElement, initial: Presentation): Surface {
    const existing = motions.get(el)
    if (existing) return existing
    const panel = (panelSelector ? (el.matches(panelSelector) ? el : el.querySelector<HTMLElement>(panelSelector)) : null) ?? el
    const original = {
      opacity: el.style.opacity,
      transform: panel.style.transform,
      backdrop: el.style.getPropertyValue('--fluid-backdrop-opacity'),
      willChange: el.style.willChange,
      panelWillChange: panel.style.willChange,
      viewerBackdrop: el.style.getPropertyValue('--viewer-backdrop-opacity'),
    }
    const restore = () => {
      el.style.opacity = original.opacity
      panel.style.transform = original.transform
      el.style.willChange = original.willChange
      if (panel !== el) panel.style.willChange = original.panelWillChange
      if (original.backdrop) el.style.setProperty('--fluid-backdrop-opacity', original.backdrop)
      else el.style.removeProperty('--fluid-backdrop-opacity')
      if (original.viewerBackdrop) el.style.setProperty('--viewer-backdrop-opacity', original.viewerBackdrop)
      else el.style.removeProperty('--viewer-backdrop-opacity')
    }
    // Dialogs use their own CSS origin; anchored Reka surfaces own collision
    // geometry. A distant trigger must not pull a centered modal sideways.
    const rect = panel.getBoundingClientRect()
    const isFullscreenViewer = panel.matches(FLUID_FULLSCREEN_SELECTOR) || rect.width > innerWidth * 0.85 || rect.height > innerHeight * 0.85

    // Image previews animate their own source-to-image proxy; moving the
    // containing surface too would shift both ends of that path.
    const imageTransition = el.hasAttribute('data-image-transition')
    const layered = imageTransition ? options.layers : undefined
    // Large image/form surfaces keep their geometry while fading. Scaling them
    // invalidates intrinsic layout and image layers during the opening frames.
    // Reduced motion settles per operation; don't permanently freeze a surface
    // created while that preference is enabled when the user turns it off later.
    const stationary = imageTransition || isFullscreenViewer || !options.animatePanel && rect.width >= 640 && rect.height >= 400
    const spring = options.small ? SURFACE_FREQUENCY : isFullscreenViewer ? 5.2 : 4.8
    const damping = options.small ? SURFACE_DAMPING : 1

    // Even an identity transform changes the containing block for fixed children.
    const style = getComputedStyle(panel)
    const x = options.small ? parseFloat(style.getPropertyValue('--surface-enter-x')) || 0 : 0
    const y = options.small ? parseFloat(style.getPropertyValue('--surface-enter-y')) || 0 : 8
    const scale = options.small ? parseFloat(style.getPropertyValue('--surface-enter-scale')) || .93 : .96
    const transform = stationary ? undefined : (progress: number) => `translate(${(1 - progress) * x}px,${(1 - progress) * y}px) scale(${scale + (1 - scale) * progress})`
    const promote = () => {
      // Promote only while moving. rAF style writes otherwise keep large,
      // newly opened forms on the main-thread paint path.
      if (!layered) el.style.willChange = panel === el && !stationary ? 'opacity, transform' : 'opacity'
      if (panel !== el && !stationary) panel.style.willChange = 'transform'
    }
    const write = (progress: number, backdrop = true, opacity = progress) => {
      promote()
      // The proxy stays opaque while the backdrop and controls arrive separately.
      // This variable changes only at timeline handoff/settle in the native path.
      if (layered) el.style.setProperty('--viewer-backdrop-opacity', String(opacity))
      else el.style.opacity = String(opacity)
      // Native ::backdrop is a separate top-layer surface, not a child: fading
      // the dialog alone leaves a solid scrim that vanishes abruptly on close.
      if (backdrop && el instanceof HTMLDialogElement) el.style.setProperty('--fluid-backdrop-opacity', String(opacity))
      if (transform) panel.style.transform = transform(progress)
    }
    // The composited path catches unavailable/failed WAAPI and owns its fallback.
    const motion = compositedMotion(el, panel, initial, spring, damping, transform, write, layered)
    const current = { motion, restore }
    motions.set(el, current)
    return current
  }
  function enter(el: Element, done: () => void) {
    const current = surface(el as HTMLElement, { value: 0, velocity: 0 })
    current.motion.to([1], false, () => { current.restore(); done() })
  }
  function leave(el: Element, done: () => void) { surface(el as HTMLElement, { value: 1, velocity: 0 }).motion.to([0], false, done) }
  function capture(el: Element) { return motions.get(el as HTMLElement)?.motion.capture() }
  function adopt(el: Element, state: Presentation) { dispose(el); surface(el as HTMLElement, state) }
  function dispose(el: Element) {
    const current = motions.get(el as HTMLElement)
    if (!current) return
    motions.delete(el as HTMLElement)
    current.motion.dispose(); current.restore()
  }
  function clear() { for (const el of [...motions.keys()]) dispose(el) }
  function finish() { for (const current of [...motions.values()]) current.motion.settle(); clear() }
  return { enter, leave, dispose, capture, adopt, clear, finish }
}

export function useFluidSurface(panelSelector?: string, options: SurfaceOptions = {}) {
  const surface = createFluidSurface(panelSelector, options)
  onDeactivated(surface.finish)
  onUnmounted(surface.finish)
  return surface
}
