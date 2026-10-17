import { getCurrentInstance, onDeactivated, onUnmounted } from 'vue'
import { createFluidMotion, FluidSpring } from '@/utils/fluidSpring'
import { listenMotionChanges, prefersReducedMotion } from '@/utils/motionPreference'
import { cssTimeToMilliseconds } from '@/utils/motionTiming'

/** Default transition consumers expose their panel as a dialog; custom cards pass an explicit selector. */
export const DEFAULT_FLUID_PANEL_SELECTOR = '[role="dialog"]'

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
function compositedMotion(el: HTMLElement, panel: HTMLElement, initial: number, frequency: number,
  transform: ((progress: number) => string) | undefined, write: (progress: number, backdrop?: boolean) => void,
): ReturnType<typeof createFluidMotion> {
  const spring = new FluidSpring(initial, frequency)
  let effects: Animation[] = [], origin = { value: initial, velocity: 0 }
  let done: (() => void) | undefined, version = 0, active = false, disposed = false
  let fallback: ReturnType<typeof createFluidMotion> | null = null
  const cancel = () => { for (const effect of effects.splice(0)) effect.cancel() }
  const finish = () => {
    if (!active || disposed) return
    active = false; spring.snap(); write(spring.value, true)
    const callback = done; done = undefined; cancel(); callback?.()
  }
  const stopPreference = listenMotionChanges(() => { if (document.hidden || prefersReducedMotion()) finish() })
  return {
    to(targets, instant = false, callback) {
      if (disposed) return
      if (fallback) { fallback.to(targets, instant, callback); return }
      const backdropOpacity = active && el instanceof HTMLDialogElement ? getComputedStyle(el, '::backdrop').opacity : String(spring.value)
      if (active && effects[0]) {
        spring.value = origin.value; spring.velocity = origin.velocity
        spring.step(Math.max(0, Number(effects[0].currentTime) || 0) / 1000)
        const presentation = Number.parseFloat(getComputedStyle(el).opacity)
        if (Number.isFinite(presentation)) spring.value = presentation
      }
      version++; const token = version
      if (instant) done?.()
      cancel(); done = callback; active = true; spring.to(targets[0])
      write(spring.value, false)
      if (instant || document.hidden || prefersReducedMotion()) { finish(); return }
      origin = { value: spring.value, velocity: spring.velocity }
      const sample = new FluidSpring(spring.value, frequency)
      sample.velocity = spring.velocity; sample.to(spring.target)
      const progress = [sample.value]
      for (let frame = 0; frame < 120 && !sample.settled; frame++) progress.push(sample.step(1 / 60))
      const opacity = progress.map(value => ({ opacity: value }))
      const transforms = transform ? progress.map(value => ({ transform: transform(value) })) : null
      const timing = { duration: Math.max(1, (progress.length - 1) * 1000 / 60), fill: 'both' as const, easing: 'linear' }
      try {
        const root = el.animate(panel === el && transforms ? opacity.map((value, index) => ({ ...value, ...transforms[index] })) : opacity, timing)
        effects.push(root)
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
        fallback = createFluidMotion([spring.value], ([value]) => write(value, true), frequency)
        fallback.to(targets, instant, callback)
      }
    },
    settle() { if (fallback) fallback.settle(); else finish() },
    dispose() { disposed = true; active = false; version++; done = undefined; cancel(); fallback?.dispose(); stopPreference() },
  }
}

/** Vue Transition hooks: v-show keeps the same physical surface during reversal. */
export function useFluidSurface(panelSelector?: string) {
  type Surface = { motion: ReturnType<typeof createFluidMotion>; restore: () => void }
  const motions = new Map<HTMLElement, Surface>()
  function surface(el: HTMLElement, initial: number): Surface {
    const existing = motions.get(el)
    if (existing) return existing
    const panel = (panelSelector ? (el.matches?.(panelSelector) ? el : el.querySelector<HTMLElement>(panelSelector)) : null) ?? el
    const original = {
      opacity: el.style.opacity,
      transform: panel.style.transform,
      origin: panel.style.transformOrigin,
      backdrop: el.style.getPropertyValue('--fluid-backdrop-opacity'),
      willChange: el.style.willChange,
      panelWillChange: panel.style.willChange,
    }
    const restore = () => {
      el.style.opacity = original.opacity
      panel.style.transform = original.transform
      panel.style.transformOrigin = original.origin
      el.style.willChange = original.willChange
      if (panel !== el) panel.style.willChange = original.panelWillChange
      if (original.backdrop) el.style.setProperty('--fluid-backdrop-opacity', original.backdrop)
      else el.style.removeProperty('--fluid-backdrop-opacity')
    }
    const source = document.activeElement instanceof HTMLElement ? document.activeElement : null
    let hasVisibleSource = false
    if (source && source !== document.body && source.isConnected && !el.contains(source)) {
      const from = source.getBoundingClientRect(), to = panel.getBoundingClientRect()
      hasVisibleSource = from.width > 0 && from.height > 0 && to.width > 0 && to.height > 0
        && from.right > 0 && from.bottom > 0 && from.left < innerWidth && from.top < innerHeight
      if (hasVisibleSource) {
        const x = Math.max(0, Math.min(100, (from.x + from.width / 2 - to.x) / to.width * 100))
        const y = Math.max(0, Math.min(100, (from.y + from.height / 2 - to.y) / to.height * 100))
        panel.style.transformOrigin = `${x}% ${y}%`
      }
    }
    const rect = panel.getBoundingClientRect()
    const isFullscreenViewer = (panel.matches && panel.matches(FLUID_FULLSCREEN_SELECTOR)) || rect.width > innerWidth * 0.85 || rect.height > innerHeight * 0.85
    const isPopover = rect.width > 0 && rect.width < 340 && rect.height < 380
    const isReduced = prefersReducedMotion()

    // Image previews animate their own source-to-image proxy; moving the
    // containing surface too would shift both ends of that path.
    const imageTransition = el.hasAttribute('data-image-transition')
    // Large image/form surfaces keep their geometry while fading. Scaling them
    // invalidates intrinsic layout and image layers during the opening frames.
    const stationary = isReduced || imageTransition || isFullscreenViewer || rect.width >= 640 && rect.height >= 400
    const scale = stationary ? 1 : isPopover ? 0.975 : 0.96
    const travel = stationary ? 0 : isPopover ? 4 : 8
    const spring = isFullscreenViewer ? 5.2 : 4.8
    if (isFullscreenViewer && !hasVisibleSource) panel.style.transformOrigin = 'center center'

    // Even an identity transform changes the containing block for fixed children.
    const transform = stationary ? undefined : (progress: number) => `translateY(${(1 - progress) * travel}px) scale(${scale + (1 - scale) * progress})`
    const promote = () => {
      // Promote only while moving. rAF style writes otherwise keep large,
      // newly opened forms on the main-thread paint path.
      el.style.willChange = panel === el && !stationary ? 'opacity, transform' : 'opacity'
      if (panel !== el && !stationary) panel.style.willChange = 'transform'
    }
    const write = (progress: number, backdrop = true) => {
      promote()
      el.style.opacity = String(progress)
      // Native ::backdrop is a separate top-layer surface, not a child: fading
      // the dialog alone leaves a solid scrim that vanishes abruptly on close.
      if (backdrop && el instanceof HTMLDialogElement) el.style.setProperty('--fluid-backdrop-opacity', String(progress))
      if (transform) panel.style.transform = transform(progress)
    }
    const motion = typeof el.animate === 'function' && (!transform || typeof panel.animate === 'function')
      ? compositedMotion(el, panel, initial, spring, transform, write)
      : createFluidMotion([initial], ([progress]) => write(progress), spring)
    const current = { motion, restore }
    motions.set(el, current)
    return current
  }
  function enter(el: Element, done: () => void) {
    const current = surface(el as HTMLElement, 0)
    current.motion.to([1], false, () => { current.restore(); done() })
  }
  function leave(el: Element, done: () => void) { surface(el as HTMLElement, 1).motion.to([0], false, done) }
  function dispose(el: Element) {
    const current = motions.get(el as HTMLElement)
    if (!current) return
    motions.delete(el as HTMLElement)
    current.motion.dispose(); current.restore()
  }
  if (getCurrentInstance()) {
    onDeactivated(() => { for (const el of [...motions.keys()]) { motions.get(el)?.motion.settle(); dispose(el) } })
    onUnmounted(() => { for (const el of [...motions.keys()]) dispose(el) })
  }
  return { enter, leave, dispose }
}
