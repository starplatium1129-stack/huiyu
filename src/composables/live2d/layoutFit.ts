import { getCompanionCharacterConfig } from '@/utils/companionRegistry'
import { computeOverlayRect } from '@/utils/live2dOverlayLayout'
import { isStageHidden, prefersReducedMotion, type Live2DCtx } from '@/composables/live2d/context'

/**
 * 桌面窗口物理像素 bounds（IPC 注入）。Companion 单窗口，属全局窗口状态：
 * CompanionView 经 ChatCharacterStage.setDesktopWindowBounds 写入，原生
 * overlay 布局据此换算，避免用 screenX/devicePixelRatio 猜测造成错位。
 * （拆分 Step 5 随 layoutFit 自 useLive2D.ts 移入）
 */
let desktopWindowBounds: { x: number; y: number; width: number; height: number } | null = null

function windowBoundsFromScreen(): { x: number; y: number } {
  // 兜底：screenX/screenY 是 CSS 像素（物理 ÷ DPR），换算回屏幕物理像素
  // 供 overlay 定位（DPR=1 时与窗口坐标一致）。桌面端由注入的
  // desktopWindowBounds 覆盖，此路径只作非桌面/未注入时的退化。
  if (desktopWindowBounds) return desktopWindowBounds
  const dpr = window.devicePixelRatio || 1
  return { x: Math.round((window.screenX || 0) * dpr), y: Math.round((window.screenY || 0) * dpr) }
}

/**
 * 布局域（拆分 Step 5 自 useLive2D.ts 原样搬出）：
 * fit（画布内模型校准）/ layout（舞台缩放与原生 overlay 帧换算）/
 * scheduleNativeLayout（rAF 重试环 ≤120 帧）/ 桌面窗口 bounds 注入。
 * DPR 换算注释全部保留——overlay 错位事故的实证记录。
 */
export function createLayoutFitController(
  ctx: Live2DCtx,
  hooks: {
    fallback: (text: string, detail: string) => void
    startEmotionClock: () => void
  },
) {
  function fit() {
    if (!ctx.model || !ctx.hostEl) return
    try {
      const cvs = ctx.session?.canvasElement?.() as HTMLCanvasElement | null
      const sw = cvs && (parseFloat(cvs.style.width) || cvs.width) || 420
      const sh = cvs && (parseFloat(cvs.style.height) || cvs.height) || 610
      const size = ctx.model.getNaturalSize()
      const nw = size.width, nh = size.height
      if (!nw || !nh) return
      // The moc bounds include different transparent margins, so each model
      // owns an explicit visual calibration rather than sharing one multiplier.
      const profile = getCompanionCharacterConfig(ctx.character.value)?.live2dLayout ?? {
        scale: 1,
        anchorX: 0.5,
        bottomOffset: 0,
      }
      const scale = Math.min(sw / nw, sh / nh) * profile.scale
      const anchorY = profile.anchorY ?? (nw > nh ? 0.5 : 1)
      ctx.model.applyFit(scale, (sw - nw * scale) * profile.anchorX, (sh - nh * scale) * anchorY + profile.bottomOffset)
    } catch (e) { hooks.fallback('Live2D 布局失败', e instanceof Error ? e.message : String(e)) }
  }

  function layout() {
    if (!ctx.ready.value || !ctx.hostEl) return
    if (ctx.session?.capability.parameterOverride === false) {
      // 原生后端：计算舞台 DOM 矩形 → 屏幕物理像素 → 下发 overlay 帧
      if (!ctx.stageEl || !ctx.session.updateOverlay) return
      // Companion 首次加载时模型可能早于 desktop getState 完成。禁止用
      // screenX/devicePixelRatio 猜首帧，否则会缓存旧窗口尺寸的错误 offset，
      // 直到用户拖动窗口触发 bounds 事件才恢复。
      if (!desktopWindowBounds) {
        ctx.nativeOverlayReady = false
        ctx.session.setPaused(true)
        return
      }
      try {
        const rect = ctx.hostEl.getBoundingClientRect()
        if (!rect.width || !rect.height) return
        const bounds = desktopWindowBounds ?? {
          ...windowBoundsFromScreen(),
          width: window.innerWidth,
          height: window.innerHeight,
        }
        // DPR 实测比例：WebView2 视口 CSS 像素与窗口物理像素的实际换算
        // （物理宽 / CSS 宽）。不能用 window.devicePixelRatio——per-monitor
        // 下它报告的是系统缩放（如 1.75），而 WebView2 视口可能按 1:1 布局，
        // 用它会整体错位（overlay 偏移、控件穿透矩形全偏）。
        const scale = bounds.width > 0 && window.innerWidth > 0
          ? bounds.width / window.innerWidth
          : (window.devicePixelRatio || 1)
        const overlayRect = computeOverlayRect({
          stageRect: rect,
          dpr: scale,
          // Native 契约使用 Companion-local 物理坐标；屏幕绝对原点由 Rust
          // 实时 GetWindowRect 获取，不能使用可能滞后的 desktop bounds x/y。
          windowBounds: { x: 0, y: 0, width: bounds.width, height: bounds.height },
        })
        ctx.nativeOverlayReady = true
        const visible = !isStageHidden(ctx) && !prefersReducedMotion()
        ctx.session.updateOverlay(overlayRect, visible)
        ctx.session.setPaused(!visible)
        if (visible) hooks.startEmotionClock()
      } catch {}
      return
    }
    if (isStageHidden(ctx)) return
    try {
      const wrapper = ctx.hostEl.firstElementChild as HTMLElement | null
      if (!wrapper) return
      // 用实际 canvas 尺寸做比例（不同模型画布不同），不硬编码 420×610
      const canvasSize = ctx.session?.getCanvasSize() ?? { width: 420, height: 610 }
      const ws = ctx.hostEl.clientWidth / canvasSize.width, hs = ctx.hostEl.clientHeight / canvasSize.height
      // Follow the available stage even on tall desktop windows; a fixed cap leaves empty space.
      const scale = Math.min(ws, hs) * 0.995
      ctx.session?.setStageScale(scale > 0 ? scale : 1)
      fit()
    } catch {}
  }

  function scheduleNativeLayout(reset = true) {
    if (reset) ctx.nativeLayoutAttempts = 0
    if (ctx.frames.nativeLayout) return
    const tick = () => {
      ctx.frames.nativeLayout = 0
      if (ctx.destroyed.value || ctx.session?.capability.parameterOverride !== false) return
      layout()
      if (ctx.nativeOverlayReady || ctx.nativeLayoutAttempts >= 120) return
      ctx.nativeLayoutAttempts += 1
      ctx.frames.nativeLayout = window.requestAnimationFrame(tick)
    }
    // 先同步测量：WebView 初次显示但尚未激活时 document.hidden 可能为 true，
    // requestAnimationFrame 也可能暂停；Native overlay 仍必须先拿到正确 frame。
    tick()
  }

  function setDesktopWindowBounds(bounds: { x: number; y: number; width: number; height: number }) {
    const previous = desktopWindowBounds
    desktopWindowBounds = bounds
    const nativeSession = ctx.session?.capability.parameterOverride === false
    const sizeChanged = !previous || previous.width !== bounds.width || previous.height !== bounds.height
    // 纯窗口移动由 Rust 每帧读取 Companion HWND 并保持本地 offset；这里若再用
    // 事件队列里的旧绝对坐标 setFrame，会与 Rust 跟随竞争并造成拖动抖动/跳位。
    if (nativeSession && ctx.nativeOverlayReady && !sizeChanged) return
    ctx.nativeOverlayReady = false
    scheduleNativeLayout()
  }

  function resetWindowBounds() {
    desktopWindowBounds = null
  }

  return { fit, layout, scheduleNativeLayout, setDesktopWindowBounds, resetWindowBounds }
}
