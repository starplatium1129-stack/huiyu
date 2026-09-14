import { onUnmounted } from 'vue'
import { createFluidMotion } from '@/utils/fluidSpring'

/** Vue Transition hooks: v-show keeps the same physical surface during reversal. */
export function useFluidSurface(panelSelector?: string) {
  const motions = new Map<HTMLElement, ReturnType<typeof createFluidMotion>>()
  function motion(el: HTMLElement, initial: number) {
    let current = motions.get(el)
    if (current) return current
    const panel = (panelSelector ? el.querySelector<HTMLElement>(panelSelector) : null) ?? el
    // A completed close leaves presentation styles behind. Measure the natural surface.
    panel.style.transform = ''; el.style.opacity = ''
    const source = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (source && source !== document.body && !el.contains(source)) {
      const from = source.getBoundingClientRect(), to = panel.getBoundingClientRect()
      panel.style.transformOrigin = `${Math.max(0, Math.min(100, (from.x + from.width / 2 - to.x) / to.width * 100))}% 0%`
    }
    const rect = panel.getBoundingClientRect()
    const isFullscreenViewer = (panel.matches && panel.matches('.art-viewer, .showcase-viewer, .candidate-compare, .pb-compare, .inpaint-modal, .viewer-layout')) || rect.width > innerWidth * 0.85 || rect.height > innerHeight * 0.85
    const isPopover = (panel.matches && panel.matches('.utility-popover, .random-popover, .popover-menu')) || (rect.width > 0 && rect.width < 340 && rect.height < 380)
    const isReduced = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

    let scale = isFullscreenViewer ? 0.992 : isPopover ? 0.975 : 0.96
    let travel = isFullscreenViewer ? 4 : isPopover ? 4 : 8
    const spring = isFullscreenViewer ? 5.2 : 4.8

    if (isReduced) {
      scale = 1
      travel = 0
    } else if (isFullscreenViewer) {
      panel.style.transformOrigin = 'center center'
    }

    current = createFluidMotion([initial], ([progress]) => {
      el.style.opacity = String(progress)
      panel.style.transform = `translateY(${(1 - progress) * -travel}px) scale(${scale + (1 - scale) * progress})`
    }, spring)
    motions.set(el, current)
    return current
  }
  function enter(el: Element, done: () => void) { motion(el as HTMLElement, 0).to([1], false, done) }
  function leave(el: Element, done: () => void) { motion(el as HTMLElement, 1).to([0], false, done) }
  function dispose(el: Element) { motions.get(el as HTMLElement)?.dispose(); motions.delete(el as HTMLElement) }
  onUnmounted(() => { motions.forEach(value => value.dispose()); motions.clear() })
  return { enter, leave, dispose }
}
