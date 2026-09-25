import { getCurrentInstance, onDeactivated, onUnmounted } from 'vue'
import { createFluidMotion } from '@/utils/fluidSpring'

/**
 * 默认浮层表面与卡片面板选择器（009 交互流畅度与性能规范）。
 * 覆盖故事卡片、模态窗卡片、批次面板、分镜面板、对比面板、备份卡片、任务中心、大图查看器等。
 */
export const DEFAULT_FLUID_PANEL_SELECTORS = [
  '.story-card',
  '.modal-card',
  '.batch-panel',
  '.shot-script-panel',
  '.pb-compare',
  '.pb-backup-card',
  '.pb-backup-modal',
  '.candidate-compare',
  '.task-center',
  '.art-viewer',
  '.showcase-viewer',
  '.guest-guide-card',
  '[role="dialog"]',
] as const

export const DEFAULT_FLUID_PANEL_SELECTOR = DEFAULT_FLUID_PANEL_SELECTORS.join(', ')

/** 全屏与超大图查看器类名清单 */
export const FLUID_FULLSCREEN_SELECTORS = [
  '.art-viewer',
  '.showcase-viewer',
  '.candidate-compare',
  '.pb-compare',
  '.inpaint-modal',
  '.viewer-layout',
] as const

export const FLUID_FULLSCREEN_SELECTOR = FLUID_FULLSCREEN_SELECTORS.join(', ')

/** 小型气泡与下拉弹出层类名清单 */
export const FLUID_POPOVER_SELECTORS = [
  '.utility-popover',
  '.random-popover',
  '.popover-menu',
] as const

export const FLUID_POPOVER_SELECTOR = FLUID_POPOVER_SELECTORS.join(', ')

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
    }
    const restore = () => {
      el.style.opacity = original.opacity
      panel.style.transform = original.transform
      panel.style.transformOrigin = original.origin
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
    const isPopover = (panel.matches && panel.matches(FLUID_POPOVER_SELECTOR)) || (rect.width > 0 && rect.width < 340 && rect.height < 380)
    const isReduced = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

    const scale = isReduced ? 1 : isFullscreenViewer ? 0.992 : isPopover ? 0.975 : 0.96
    const travel = isReduced ? 0 : isFullscreenViewer || isPopover ? 4 : 8
    const spring = isFullscreenViewer ? 5.2 : 4.8
    if (isFullscreenViewer && !hasVisibleSource) panel.style.transformOrigin = 'center center'

    const motion = createFluidMotion([initial], ([progress]) => {
      el.style.opacity = String(progress)
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
  if (getCurrentInstance()) {
    onDeactivated(() => { for (const el of [...motions.keys()]) { motions.get(el)?.motion.settle(); dispose(el) } })
    onUnmounted(() => { for (const el of [...motions.keys()]) dispose(el) })
  }
  return { enter, leave, dispose }
}
