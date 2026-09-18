import { onDeactivated, onUnmounted } from 'vue'
import { createFluidMotion } from '@/utils/fluidSpring'

/** Vue Transition hooks: v-show keeps the same physical surface during reversal. */
export function useFluidSurface(panelSelector?: string) {
  type Surface = { motion: ReturnType<typeof createFluidMotion>; restore: () => void }
  const motions = new Map<HTMLElement, Surface>()
  function surface(el: HTMLElement, initial: number): Surface {
    const existing = motions.get(el)
    if (existing) return existing
    const panel = (panelSelector ? el.querySelector<HTMLElement>(panelSelector) : null) ?? el
    const original = { opacity: el.style.opacity, transform: panel.style.transform, origin: panel.style.transformOrigin }
    const restore = () => {
      el.style.opacity = original.opacity
      panel.style.transform = original.transform
      panel.style.transformOrigin = original.origin
    }
    const rect = panel.getBoundingClientRect()
    const isFullscreenViewer = panel.matches('.art-viewer, .showcase-viewer, .candidate-compare, .pb-compare, .inpaint-modal, .viewer-layout') || rect.width > innerWidth * 0.85 || rect.height > innerHeight * 0.85
    const isPopover = panel.matches('.utility-popover, .random-popover, .popover-menu') || (rect.width > 0 && rect.width < 340 && rect.height < 380)
    const scale = isFullscreenViewer ? 0.992 : isPopover ? 0.975 : 0.96
    const travel = isFullscreenViewer || isPopover ? 4 : 8
    const spring = isFullscreenViewer ? 5.2 : 4.8
    let origin = 'center center'
    const source = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (source && source !== document.body && source.isConnected && !el.contains(source) && rect.width > 0 && rect.height > 0) {
      const from = source.getBoundingClientRect()
      const visible = from.width > 0 && from.height > 0 && from.right > 0 && from.bottom > 0 && from.left < innerWidth && from.top < innerHeight
      if (visible && (!isFullscreenViewer || panel.matches('.art-viewer'))) {
        const clamp = (value: number) => Math.max(0, Math.min(100, value))
        const x = clamp((from.left + from.width / 2 - rect.left) / rect.width * 100)
        const y = panel.matches('.art-viewer') ? clamp((from.top + from.height / 2 - rect.top) / rect.height * 100) : 0
        origin = `${x}% ${y}%`
      }
    }
    const motion = createFluidMotion([initial], ([progress]) => {
      el.style.opacity = String(progress)
      panel.style.transformOrigin = origin
      panel.style.transform = `translateY(${(1 - progress) * -travel}px) scale(${scale + (1 - scale) * progress})`
    }, spring)
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
  onDeactivated(() => {
    for (const [el, current] of [...motions]) { current.motion.settle(); dispose(el) }
  })
  onUnmounted(() => { for (const el of [...motions.keys()]) dispose(el) })
  return { enter, leave, dispose }
}
