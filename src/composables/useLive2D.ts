import type { EmotionRuntime } from '@/utils/emotionRuntime'
import { createLive2DCtx, type Live2DStatus } from '@/composables/live2d/context'
import { createPointerGazeController } from '@/composables/live2d/pointerGaze'
import { createInteractionController } from '@/composables/live2d/interactions'
import { createNativeEmotionClock } from '@/composables/live2d/emotionClock'
import { createLayoutFitController } from '@/composables/live2d/layoutFit'
import { createParameterFrame } from '@/composables/live2d/parameterFrame'
import { createLifecycleController } from '@/composables/live2d/lifecycle'

export type { Live2DStatus }

/**
 * useLive2D 组合根（拆分 Step 7 收薄）：
 * 构建 ctx → 接线 live2d/ 各子模块 → 返回原公开 API（逐字冻结，消费方零改动）。
 * 状态机与生命周期在 lifecycle.ts；destroyRuntime 仍是全库唯一复位点。
 * 依赖注入用箭头延迟绑定（layoutFit→lifecycle.fallback、interactions→
 * lifecycle.resumeRendering），构造期无调用，运行期 controllers 已就绪。
 */
export function useLive2D(onStatus: (s: Live2DStatus) => void = () => {}) {
  const ctx = createLive2DCtx()
  const pointerGaze = createPointerGazeController(ctx)
  const emotionClock = createNativeEmotionClock(ctx)
  const layoutFit = createLayoutFitController(ctx, {
    fallback: (text: string, detail: string) => lifecycle.fallback(text, detail),
    startEmotionClock: emotionClock.start,
  })
  const interactions = createInteractionController(ctx, {
    setState,
    resumeRendering: () => lifecycle.resumeRendering(),
  })
  const parameterFrame = createParameterFrame(ctx, { beginOverlaySettle: interactions.beginOverlaySettle })
  const lifecycle = createLifecycleController(
    ctx,
    { pointerGaze, emotionClock, layoutFit, interactions, parameterFrame },
    { setState },
  )

  function setState(state: Live2DStatus['state'], text: string, detail = '', retryable = false) {
    if (ctx.hostEl) { ctx.hostEl.dataset.state = state; ctx.hostEl.dataset.error = detail; ctx.hostEl.dataset.retryable = retryable ? 'true' : 'false' }
    onStatus({ state, text, detail, retryable, ready: ctx.ready.value })
  }

  function setMaxFps(value: number) {
    // 原生后端接电目标 165fps（渲染线程 vsync 决定实际帧率），不能被默认
    // 60 覆盖；browser 后端保持原有 120 上限不变。
    const isNative = ctx.backendKind.value === 'native' && ctx.backend?.kind === 'native'
    const cap = isNative ? 165 : 120
    ctx.maxFps = Math.max(24, Math.min(cap, Math.round(value) || 60))
    ctx.session?.setMaxFps(ctx.maxFps)
  }

  function attachEmotionRuntime(runtime: EmotionRuntime | null) {
    ctx.emotionRuntime = runtime
    ctx.nativeAnimationAdapter.reset()
    for (const key of Object.keys(ctx.emotionCurrent)) delete ctx.emotionCurrent[key]
    ctx.lastParamFrame = 0
  }

  function setMouth(value: number) {
    ctx.mouthValue.value = Math.max(0, Math.min(1, Number(value) || 0))
    // Do not depend solely on the internal event emitter. Some Cubism builds
    // skip it for a frame after an outfit change, which made speech look
    // frozen even while the audio analyser was producing amplitudes.
    parameterFrame.apply()
    if (ctx.mouthValue.value > 0) lifecycle.resumeRendering()
  }

  function setAudioLevel(level: number, peak = level) {
    ctx.emotionRuntime?.setAudioLevel(level, peak)
  }

  function setVolume(value: number) {
    ctx.interactionVolume = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.8
    if (ctx.interactionAudio) ctx.interactionAudio.volume = ctx.interactionVolume
  }

  async function setExpression(name: string): Promise<boolean> {
    if (!ctx.ready.value || ctx.loadedCharacter.value !== ctx.character.value) return false
    const { resolveCompanionAvatar } = await import('@/utils/companionRegistry')
    const options = resolveCompanionAvatar(ctx.character.value)?.avatar.expressions || []
    if (name && !options.some(option => option.id === name)) return false
    const model = ctx.model
    try {
      const result = await model?.expression(name)
      if (model !== ctx.model) return false
      if (result) {
        ctx.expressionParamIds = new Set(options.find(option => option.id === name)?.parameterIds || [])
        lifecycle.resumeRendering()
      }
      return result === true
    } catch { return false }
  }

  // 换装和口型都依赖 Pixi ticker。某些 Cubism 模型在切换 Expression 后会停掉 idle
  // motion；语音开始时显式恢复渲染，避免出现"有声音但立绘冻结"。
  function setSpeaking(value: boolean) {
    ctx.speaking = value
    ctx.emotionRuntime?.setSpeaking(value)
    if (value) {
      interactions.stopAudio()
      lifecycle.resumeRendering()
    }
    else {
      ctx.mouthValue.value = 0
      ctx.session?.sendMouthLevel?.(0)
    }
  }

  return {
    ready: ctx.ready, enabled: ctx.enabled, character: ctx.character, loadedCharacter: ctx.loadedCharacter,
    mouthValue: ctx.mouthValue, interactionHint: ctx.interactionHint, outfit: ctx.outfit, quality: ctx.quality,
    backendKind: ctx.backendKind, backendFallback: ctx.backendFallback, adapterReport: ctx.adapterReport,
    init: lifecycle.init, enable: lifecycle.enable, disable: lifecycle.disable,
    setCharacter: lifecycle.setCharacter, setMouth, setAudioLevel, setVolume, setExpression, setOutfit: lifecycle.setOutfit, setQuality: lifecycle.setQuality, setSpeaking,
    attachEmotionRuntime, setPaused: lifecycle.setPaused, setMaxFps, recover: lifecycle.recover,
    layout: layoutFit.layout, retry: lifecycle.retry, destroy: lifecycle.destroy,
    setGlobalPointer: pointerGaze.setGlobalPointer, releasePointerFocus: pointerGaze.release,
    setDesktopWindowBounds: layoutFit.setDesktopWindowBounds, syncNativeEmotion: emotionClock.syncIntent,
  }
}
