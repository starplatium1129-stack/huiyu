import type { Live2DCtx } from '@/composables/live2d/context'
import { prefersReducedMotion } from '@/composables/live2d/context'
import { resolveCompanionAvatar } from '@/utils/companionRegistry'

const normalizedLevel = (value: number): number => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0

export function selectMouthParams(character: string): { id: string; scale: number } | undefined {
  return resolveCompanionAvatar(character)?.profile.parameterBindings.mouth
}

export function selectBlinkParams(character: string): readonly string[] | undefined {
  return resolveCompanionAvatar(character)?.profile.parameterBindings.blink
}

/**
 * 每帧参数写入热路径（拆分 Step 6 自 useLive2D.ts 逐行对照迁移）：
 * 口型/眨眼/登场窗口/叠层守卫与回落/情绪平滑/凝视回退。
 * 被 beforeModelUpdate 钩子与 setMouth 双入口调用；原生后端只传口型意图。
 * 全部事故注释是实机实证记录，禁止改写。
 */
export function createParameterFrame(
  ctx: Live2DCtx,
  hooks: {
    beginOverlaySettle: () => void
  },
) {
  function apply() {
    if (!ctx.model?.visible) return
    const now = performance.now()
    const dt = Math.min(0.12, (now - ctx.lastParamFrame) / 1000 || 1 / 60)
    ctx.lastParamFrame = now
    if (ctx.session?.capability.parameterOverride === false) {
      // 原生后端：只传口型意图，参数级写入由 Cubism Native 按作者工程执行。
      // blinkScheduler / MOUTH_PARAMS 参数 hack 全部退役。情绪推进只有一个
      // 时钟（nativeEmotionTick 的 requestAnimationFrame），口型回调不得再次
      // update emotionRuntime，否则同一帧会被推进两次。
      if (ctx.speaking && ctx.adapter?.mouth) ctx.session.sendMouthLevel?.(ctx.mouthValue.value)
      if (ctx.stageEl) ctx.stageEl.dataset.blink = '1.000'
      return
    }
    try {
      // Cubism motion/physics run before this event. Write with full weight so
      // their idle values cannot overwrite the audio amplitude or emotion.
      if (ctx.speaking) {
        const mouth = ctx.adapter?.mouth
        if (mouth) ctx.model.setParameterValueById(mouth.id, Math.max(mouth.range?.[0] ?? -Infinity,
          Math.min(mouth.range?.[1] ?? Infinity, mouth.closed !== undefined && mouth.open !== undefined
            ? mouth.closed + normalizedLevel(ctx.mouthValue.value) * (mouth.open - mouth.closed) : ctx.mouthValue.value * mouth.scale)), 1)
      }
      // 覆盖式眨眼：双眼参数永远写同一个值（1=睁、0=闭），修掉作者眼曲线
      // 左右眼不同步造成的"单眼 Wink"，并保证定时眨眼（见 blinkScheduler）。
      // 登场动作（Start 组）期间暂停覆盖：其眼曲线左右同步（含开场闭眼），
      // 让作者动画原样呈现。
      // Cubism 在本帧参数钩子之前更新动作状态。优先按实际结束交还控制权，
      // 避免短变体结束后仍按整组最长时长放行叠层；旧运行库保留计时兜底。
      const activeGroup = ctx.model.getActiveMotionGroup?.()
      const entranceGroup = ctx.adapter?.entranceGroup
      const inEntrance = Boolean(entranceGroup && now < ctx.entranceUntil
        && (activeGroup === undefined || activeGroup === entranceGroup))
      if (!inEntrance) ctx.entranceUntil = 0
      if (ctx.activeInteraction && activeGroup !== undefined && activeGroup !== ctx.activeInteraction) {
        ctx.activeInteraction = ''
        clearTimeout(ctx.timers.interaction)
        ctx.timers.interaction = 0
      }
      if (inEntrance) {
        if (ctx.stageEl) ctx.stageEl.dataset.blink = '1.000'
      } else {
        const blinkValue = ctx.blinkScheduler.update(dt)
        const blinkIds = ctx.adapter?.blink
        if (blinkIds?.length) {
          for (const id of blinkIds) if (!ctx.expressionParamIds.has(id)) {
            const binding = ctx.adapter?.blinkCalibration?.[id]
            const value = binding ? binding.closed + normalizedLevel(blinkValue) * (binding.open - binding.closed) : blinkValue
            ctx.model.setParameterValueById(id, value, 1)
          }
        }
        if (ctx.stageEl) ctx.stageEl.dataset.blink = blinkValue.toFixed(3)
      }
      if (ctx.stageEl) ctx.stageEl.dataset.entrance = inEntrance ? '1' : '0'
      // 叠层参数守卫 + 平滑回落（2026-08-23 换装闪回修复）：Idle 动作
      // Idle_6 会把 Param36/37 拉出隐藏态（到 5+），静止时叠层显示 →
      // 眼睛/全身发灰；互动（Tap）或登场（Start）播放期间让动作曲线驱动
      // 叠层（设计行为）。动作曲线交还所有权的瞬间（entranceUntil 过期/
      // 互动计时清空 activeInteraction）启动 smoothstep 回落（与原生端
      // OVERLAY_SETTLE_SECONDS 同款），替代原先的单帧硬写——后者让换装
      // 部件一帧内消失/回穿，视觉上是"闪一下"；回落结束后恢复每帧硬性
      // 写回隐藏态（0/-1 分组）——与 native 端 step_overlay_settle /
      // force_overlay_hidden 行为一致。
      const interactionPlaying = ctx.activeInteraction !== ''
      const overlayByMotion = inEntrance || interactionPlaying
      if (overlayByMotion) {
        ctx.overlaySettle = null
      } else if (ctx.overlayWasByMotion && ctx.adapter?.overlaySettle) {
        hooks.beginOverlaySettle()
      }
      ctx.overlayWasByMotion = overlayByMotion
      const overlay = ctx.adapter?.overlaySettle
      if (!overlayByMotion && overlay) {
        if (ctx.overlaySettle) {
          const t = Math.min(1, (now - ctx.overlaySettle.start) / overlay.settleMs)
          const eased = t * t * (3 - 2 * t)
          for (const { id, from, to } of ctx.overlaySettle.entries) {
            try { ctx.model.setParameterValueById(id, from + (to - from) * eased, 1) } catch { /* 参数缺失忽略 */ }
          }
          if (t >= 1) ctx.overlaySettle = null
        } else {
          for (const [id, value] of Object.entries(overlay.resetDefaults)) {
            try { ctx.model.setParameterValueById(id, value, 1) } catch { /* 参数缺失忽略 */ }
          }
        }
      }
      if (!ctx.emotionRuntime) return
      ctx.emotionRuntime.update(dt)
      if (ctx.stageEl) ctx.stageEl.dataset.emotionIntensity = ctx.emotionRuntime.intensity().toFixed(3)
      const frame = ctx.emotionRuntime.performanceFrame()
      if (!prefersReducedMotion()) {
        void ctx.nativeAnimationAdapter.apply(frame.nativeAnimation, ctx.model, ctx.character.value)
      }
      const targets = { ...frame.live2dParams, ...ctx.emotionRuntime.targets() }
      for (const id of ctx.expressionParamIds) { delete targets[id]; delete ctx.emotionCurrent[id] }
      for (const id of ctx.nativeAnimationAdapter.activeSuppressedParamIds()) {
        delete targets[id]
        delete ctx.emotionCurrent[id]
      }
      if (typeof ctx.model.focus === 'function') {
        // pixi-live2d-display already maps focus to the model's authored eye
        // and head parameters. Do not overwrite those values with SoulLink.
        if (ctx.gaze.active) {
          for (const id of ctx.adapter?.focus || []) {
            delete targets[id]
            delete ctx.emotionCurrent[id]
          }
        }
      } else {
        // Keep a parameter fallback for runtimes without the native focus API.
        if (ctx.gaze.active || Math.abs(ctx.gaze.currentX) > 0.01 || Math.abs(ctx.gaze.currentY) > 0.01) {
          targets.ParamEyeBallX = ctx.gaze.currentX
          targets.ParamEyeBallY = ctx.gaze.currentY
        }
      }
      for (const [id, target] of Object.entries(targets)) {
        const current = ctx.emotionCurrent[id] ?? 0
        const next = current + (target - current) * Math.min(1, dt * 6)
        ctx.emotionCurrent[id] = next
        ctx.model.setParameterValueById(id, next, 1)
      }
      // 归零的参数交还给 idle 动作，避免表情参数常驻覆写把待机动画压死
      for (const id of Object.keys(ctx.emotionCurrent)) {
        if (targets[id] === 0 && Math.abs(ctx.emotionCurrent[id]) < 0.004) {
          delete ctx.emotionCurrent[id]
        }
      }
    } catch {}
  }

  function bindMouthOverride() {
    if (!ctx.model || ctx.mouthHooked) return
    // 原生后端：参数由作者工程执行，不需要 beforeModelUpdate 钩子
    if (ctx.session?.capability.parameterOverride === false) return
    ctx.mouthHooked = true
    ctx.model.onBeforeModelUpdate(apply)
  }

  return { apply, bindMouthOverride }
}
