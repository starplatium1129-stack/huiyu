import { getCurrentInstance, onUnmounted } from 'vue'
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
  const motions = new Map<HTMLElement, ReturnType<typeof createFluidMotion>>()
  function motion(el: HTMLElement, initial: number) {
    let current = motions.get(el)
    if (current) return current
    const panel = (panelSelector ? (el.matches?.(panelSelector) ? el : el.querySelector<HTMLElement>(panelSelector)) : null) ?? el
    // A completed close leaves presentation styles behind. Measure the natural surface.
    panel.style.transform = ''; el.style.opacity = ''
    const source = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (source && source !== document.body && !el.contains(source)) {
      const from = source.getBoundingClientRect(), to = panel.getBoundingClientRect()
      panel.style.transformOrigin = `${Math.max(0, Math.min(100, (from.x + from.width / 2 - to.x) / to.width * 100))}% 0%`
    }
    const rect = panel.getBoundingClientRect()
    const isFullscreenViewer = (panel.matches && panel.matches(FLUID_FULLSCREEN_SELECTOR)) || rect.width > innerWidth * 0.85 || rect.height > innerHeight * 0.85
    const isPopover = (panel.matches && panel.matches(FLUID_POPOVER_SELECTOR)) || (rect.width > 0 && rect.width < 340 && rect.height < 380)
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
  if (getCurrentInstance()) {
    onUnmounted(() => { motions.forEach(value => value.dispose()); motions.clear() })
  }
  return { enter, leave, dispose }
}
