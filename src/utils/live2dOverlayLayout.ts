/**
 * Live2D overlay 布局换算 —— 纯函数，无 DOM 依赖。
 *
 * 契约：该纯函数支持屏幕或窗口本地物理像素；Native Companion 传入 0,0
 * 原点得到窗口本地矩形，Rust 再用实时 HWND 位置换算为屏幕坐标。
 * 输入是 WebView2 内的 CSS 像素矩形（getBoundingClientRect 结果），
 * 换算关系：
 *
 *   screenX = windowBounds.x + rect.left * dpr
 *   screenY = windowBounds.y + rect.top * dpr
 *   width   = rect.width * dpr
 *   height  = rect.height * dpr
 *
 * windowBounds 为无边框窗口的内容区屏幕位置（Companion/Atelier 均无系统
 * 边框，窗口区 == 内容区）。多屏场景允许传入 monitors 做屏幕内钳制。
 */

export interface OverlayRectCss {
  left: number
  top: number
  width: number
  height: number
}

export interface OverlayWindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface OverlayMonitor {
  x: number
  y: number
  width: number
  height: number
}

export interface OverlayLayoutInput {
  /** 舞台元素的 getBoundingClientRect（CSS 像素，相对 viewport） */
  stageRect: OverlayRectCss
  /** devicePixelRatio（Windows 缩放 100%=1，125%=1.25，150%=1.5…） */
  dpr: number
  /** 宿主窗口内容区屏幕位置（物理像素）。缺失时假定 0,0。 */
  windowBounds?: OverlayWindowBounds | null
  /** 可选：屏幕列表（物理像素），做越界钳制 */
  monitors?: readonly OverlayMonitor[]
}

export interface OverlayRect {
  x: number
  y: number
  width: number
  height: number
}

const EPS = 1e-6

export function computeOverlayRect(input: OverlayLayoutInput): OverlayRect {
  const { stageRect, dpr } = input
  const bounds = input.windowBounds ?? { x: 0, y: 0, width: 0, height: 0 }
  const d = Math.max(0.25, Number(dpr) || 1)
  const rect: OverlayRect = {
    x: Math.round((bounds.x || 0) + stageRect.left * d),
    y: Math.round((bounds.y || 0) + stageRect.top * d),
    width: Math.max(1, Math.round(stageRect.width * d)),
    height: Math.max(1, Math.round(stageRect.height * d)),
  }
  return clampToMonitors(rect, input.monitors)
}

/** 把 overlay 钳制回可见屏幕：四边不超过任一 monitor 的范围。 */
export function clampToMonitors(rect: OverlayRect, monitors?: readonly OverlayMonitor[]): OverlayRect {
  if (!monitors || monitors.length === 0) return { ...rect }
  let x = rect.x
  let y = rect.y
  let width = rect.width
  let height = rect.height
  for (const monitor of monitors) {
    const maxX = monitor.x + monitor.width
    const maxY = monitor.y + monitor.height
    if (x >= monitor.x - EPS && y >= monitor.y - EPS && x + width <= maxX + EPS && y + height <= maxY + EPS) {
      // 完全在某个屏幕内：不动
      return { x, y, width, height }
    }
    // 与屏幕有交集：把超出部分收进屏幕
    const right = Math.min(x + width, maxX)
    const bottom = Math.min(y + height, maxY)
    const nx = Math.max(x, monitor.x)
    const ny = Math.max(y, monitor.y)
    if (right > nx + EPS && bottom > ny + EPS) {
      x = nx
      y = ny
      width = right - nx
      height = bottom - ny
    }
  }
  return { x: Math.round(x), y: Math.round(y), width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) }
}
