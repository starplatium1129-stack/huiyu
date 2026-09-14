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
    const large = panel.getBoundingClientRect().width > innerWidth * .85
    const scale = large ? .99 : .96, travel = large ? 6 : 12
    current = createFluidMotion([initial], ([progress]) => {
      el.style.opacity = String(progress)
      panel.style.transform = `translateY(${(1 - progress) * -travel}px) scale(${scale + (1 - scale) * progress})`
    }, 4.8)
    motions.set(el, current)
    return current
  }
  function enter(el: Element, done: () => void) { motion(el as HTMLElement, 0).to([1], false, done) }
  function leave(el: Element, done: () => void) { motion(el as HTMLElement, 1).to([0], false, done) }
  function dispose(el: Element) { motions.get(el as HTMLElement)?.dispose(); motions.delete(el as HTMLElement) }
  onUnmounted(() => { motions.forEach(value => value.dispose()); motions.clear() })
  return { enter, leave, dispose }
}
