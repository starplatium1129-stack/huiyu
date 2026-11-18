import { isStageHidden, prefersReducedMotion, type Live2DCtx } from './context'

export function createStageVisibility(ctx: Live2DCtx, controllers: {
  layoutFit: { layout(): void }
  emotionClock: { start(): void; stop(): void }
  interactions: { stopAudio(): void }
}, recover: () => Promise<void>) {
  let removeMotionListener: (() => void) | undefined

  function observeSize() {
    if (!ctx.hostEl) return
    if ('ResizeObserver' in window && !ctx.resizeObserver) {
      ctx.resizeObserver = new ResizeObserver(() => controllers.layoutFit.layout()); ctx.resizeObserver.observe(ctx.hostEl)
    } else {
      window.addEventListener('resize', (ctx.onResize = () => controllers.layoutFit.layout()))
    }
  }

  function bindVisibility() {
    if (ctx.visibilityHandler) return
    ctx.visibilityHandler = syncPause
    document.addEventListener('visibilitychange', ctx.visibilityHandler)
    ctx.motionQuery = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null
    ctx.motionPreferenceHandler = syncPause
    const media = ctx.motionQuery
    if (typeof media?.addEventListener === 'function') {
      media.addEventListener('change', syncPause); removeMotionListener = () => media.removeEventListener('change', syncPause)
    } else if (typeof media?.addListener === 'function') {
      media.addListener(syncPause); removeMotionListener = () => media.removeListener(syncPause)
    }
    window.addEventListener('atelier:motion-preference', syncPause)
  }

  function resumeRendering(refreshLayout = true) {
    if (!ctx.session || isStageHidden(ctx) || prefersReducedMotion()) return
    if (refreshLayout) controllers.layoutFit.layout()
    if (ctx.session.capability.parameterOverride === false && !ctx.nativeOverlayReady) return
    ctx.session.setPaused(false)
    controllers.emotionClock.start()
  }

  function syncPause() {
    if (!ctx.session) { void recover(); return }
    // 减少动态效果：渲染一帧把立绘摆正，然后停住，不做待机循环
    const waitingForNativeBounds = ctx.session?.capability.parameterOverride === false && !ctx.nativeOverlayReady
    const shouldPause = isStageHidden(ctx) || prefersReducedMotion() || waitingForNativeBounds
    if (ctx.session.kind === 'browser' && ctx.ready.value && ctx.model?.visible
      && prefersReducedMotion() && !isStageHidden(ctx)) ctx.session.setPaused(true, true)
    else ctx.session.setPaused(shouldPause)
    if (shouldPause) {
      controllers.emotionClock.stop()
      if (ctx.frames.gaze) window.cancelAnimationFrame(ctx.frames.gaze)
      ctx.frames.gaze = 0
      ctx.lastParamFrame = 0
      if (isStageHidden(ctx)) controllers.interactions.stopAudio()
    }
    else controllers.emotionClock.start()
  }

  function dispose() {
    ctx.resizeObserver?.disconnect()
    if (ctx.onResize) window.removeEventListener('resize', ctx.onResize)
    if (ctx.visibilityHandler) { document.removeEventListener('visibilitychange', ctx.visibilityHandler); ctx.visibilityHandler = null }
    removeMotionListener?.(); removeMotionListener = undefined
    window.removeEventListener('atelier:motion-preference', syncPause)
    ctx.motionQuery = null; ctx.motionPreferenceHandler = null
  }
  return { observeSize, bindVisibility, resumeRendering, syncPause, dispose }
}

export function bindStageContextEvents(ctx: Live2DCtx, fallback: (text: string, detail: string) => void, retry: () => void) {
  if (!ctx.hostEl) return
  const cvs = ctx.session?.canvasElement?.() as HTMLCanvasElement | null
  if (!cvs || cvs.dataset.contextEvents === '1') return
  cvs.dataset.contextEvents = '1'
  cvs.addEventListener('webglcontextlost', (e) => {
    e.preventDefault()
    // 销毁/卸载阶段（disable、角色切换）移除 canvas 也会触发该事件，
    // 此时模型已经下线，不能再用"图形上下文已暂停"覆盖退出提示。
    if (!ctx.ready.value || !ctx.model) return
    fallback('Live2D 图形上下文已暂停', 'WebGL context lost')
  })
  cvs.addEventListener('webglcontextrestored', () => retry())
}
