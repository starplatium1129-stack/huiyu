import { isStageHidden, prefersReducedMotion, type Live2DCtx } from '@/composables/live2d/context'
import { gazeFromClientPoint, gazeSettled, stepGaze } from '@/utils/live2dGaze'

/**
 * 指针凝视控制器（拆分 Step 3 自 useLive2D.ts 原样搬出）：
 * 窗口内 mousemove/mouseleave 驱动 + 自包含 rAF 平滑循环 + 桌面全局指针入口。
 * 凝视共享值存 ctx.gaze（applyParameters 的参数回退路径读取 currentX/Y）。
 * DOM 监听移除（destroy）与 rAF 取消（destroyRuntime）仍由 useLive2D 统一
 * 执行——全库唯一复位路径，本模块不自带清理副本。
 */
export function createPointerGazeController(ctx: Live2DCtx) {
  let pendingPointer: { x: number; y: number; global: boolean; token: number } | null = null

  function queuePointer(x: number, y: number, global: boolean) {
    if (!ctx.ready.value || !ctx.model || ctx.destroyed.value || isStageHidden(ctx) || prefersReducedMotion()) return
    // High-rate pointer devices can deliver many events per rendered frame.
    // Measure the stage once, using the latest coordinates at frame time.
    pendingPointer = { x, y, global, token: ctx.lifecycleToken }
    schedule()
  }

  function bind() {
    if (!ctx.stageEl || ctx.pointerGazeHandler) return
    ctx.pointerGazeHandler = (event) => {
      queuePointer(event.clientX, event.clientY, false)
    }
    ctx.pointerGazeLeaveHandler = release
    ctx.stageEl.addEventListener('mousemove', ctx.pointerGazeHandler)
    ctx.stageEl.addEventListener('mouseleave', ctx.pointerGazeLeaveHandler)
  }

  function schedule() {
    if (ctx.frames.gaze || !ctx.ready.value || !ctx.model || isStageHidden(ctx) || prefersReducedMotion()) return
    ctx.gaze.lastFrame = performance.now()
    ctx.frames.gaze = window.requestAnimationFrame(runFrame)
  }

  function runFrame(now: number) {
    ctx.frames.gaze = 0
    const pointer = pendingPointer
    pendingPointer = null
    if (!ctx.ready.value || !ctx.model || ctx.destroyed.value || isStageHidden(ctx) || prefersReducedMotion()) return
    if (pointer && pointer.token === ctx.lifecycleToken) {
      const rect = ctx.stageEl?.getBoundingClientRect()
      if (rect?.width && rect.height) {
        const target = gazeFromClientPoint(pointer.x, pointer.y, rect, pointer.global ? 0.82 : 1)
        ctx.gaze.x = target.x
        ctx.gaze.y = target.y
        ctx.gaze.active = true
        ctx.gaze.kind = pointer.global ? 'global' : typeof ctx.model.focus === 'function' ? 'native' : 'fallback'
      }
    }
    const dt = Math.max(1 / 240, Math.min(0.05, (now - ctx.gaze.lastFrame) / 1000))
    ctx.gaze.lastFrame = now
    const next = stepGaze(
      { x: ctx.gaze.currentX, y: ctx.gaze.currentY },
      { x: ctx.gaze.x, y: ctx.gaze.y },
      dt,
      ctx.gaze.active ? 12 : 6,
    )
    ctx.gaze.currentX = next.x
    ctx.gaze.currentY = next.y
    const focus = ctx.model.focus
    if (focus) {
      const screen = ctx.session?.getScreenSize() ?? { width: 420, height: 610 }
      focus.call(
        ctx.model,
        (ctx.gaze.currentX + 1) * 0.5 * screen.width,
        (1 - ctx.gaze.currentY) * 0.5 * screen.height,
      )
    }
    ctx.session?.sendGaze?.(ctx.gaze.currentX, ctx.gaze.currentY)
    if (ctx.stageEl) {
      ctx.stageEl.dataset.pointerFocus = ctx.gaze.active ? ctx.gaze.kind : 'idle'
      ctx.stageEl.dataset.pointerGazeX = ctx.gaze.currentX.toFixed(3)
      ctx.stageEl.dataset.pointerGazeY = ctx.gaze.currentY.toFixed(3)
    }
    const settled = gazeSettled(
      { x: ctx.gaze.currentX, y: ctx.gaze.currentY },
      { x: ctx.gaze.x, y: ctx.gaze.y },
    )
    if (settled) {
      ctx.gaze.currentX = ctx.gaze.x
      ctx.gaze.currentY = ctx.gaze.y
      return
    }
    ctx.frames.gaze = window.requestAnimationFrame(runFrame)
  }

  function release() {
    pendingPointer = null
    ctx.gaze.active = false
    ctx.gaze.x = 0
    ctx.gaze.y = 0
    ctx.gaze.kind = 'idle'
    if (ctx.stageEl) ctx.stageEl.dataset.pointerFocus = 'idle'
    schedule()
  }

  /**
   * 全局目光凝视（桌面悬浮窗外）：主进程轮询屏幕鼠标坐标并经 IPC 送达。
   * 与窗口内 DOM 逻辑共用同一套归一化与 focus 坐标变换；窗口内更新由
   * DOM 事件负责（更平滑），这里只处理鼠标在窗口外的时刻。
   */
  function setGlobalPointer(screenX: number, screenY: number, windowBounds: { x: number; y: number; width: number; height: number }): void {
    // 无边框窗口的 bounds 即内容区在屏幕上的位置：clientX = 屏幕坐标 − bounds
    const clientX = screenX - windowBounds.x
    const clientY = screenY - windowBounds.y
    queuePointer(clientX, clientY, true)
  }

  return { bind, release, setGlobalPointer }
}
