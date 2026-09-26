import { resolveRuntimeUrl, runtimeResourceCors } from '../../platform/runtimeUrl.ts'
import { useCompanionAffection } from '../useCompanionAffection.ts'
import type { Live2DInteraction } from './constants.ts'
import type { Live2DCtx, Live2DStatus } from './context.ts'
import { prefersReducedMotion } from './context.ts'
import { isRecord } from './catalog.ts'
import { resolveCompanionAvatar } from '../../utils/companionRegistry.ts'
import { hasAffectionMotionRules } from '../../utils/companionAffection.ts'

/** 分区带映射：舞台归一化坐标（x/y ∈ [0,1]）→ 互动动作。 */
export function resolveStageInteraction(character: string, x: number, y: number): Live2DInteraction | null {
  const profile = resolveCompanionAvatar(character)?.profile
  if (!profile?.interactions) return null
  const zone = profile.stageHitZones?.find(candidate => {
    const maxX = candidate.maxX ?? 1
    return y >= candidate.minY && y < candidate.maxY
      && x >= (candidate.minX ?? 0) && (candidate.maxXInclusive || maxX === 1 ? x <= maxX : x < maxX)
  })
  if (zone) return profile.interactions[zone.interactionId] ?? null
  return profile.defaultInteractionId ? profile.interactions[profile.defaultInteractionId] ?? null : null
}

/**
 * 原生路径：Cubism 原生 HitArea 命中（作者分区）→ 互动动作。
 * 夏目的"外框"是环绕角色的矩形命中区，与头/手/胸/裙/腿/脚分区重叠，
 * 且 model3.json HitAreas 顺序排第一——直接取首个会让所有点击都变成
 * "抬眼"反应（2026-08-16 实机：头/手/裙/腿点击全部命中外框）。
 * 具体分区优先，外框只在没有其他分区命中时兜底（点到角色外的框空白处）。
 */
export function resolveHitAreaInteraction(character: string, areas: string[]): Live2DInteraction | null {
  const profile = resolveCompanionAvatar(character)?.profile
  if (!profile?.interactions) return null
  const fallbacks = new Set(profile.hitAreaFallbacks || [])
  const ordered = [...areas.filter(area => !fallbacks.has(area)), ...areas.filter(area => fallbacks.has(area))]
  return ordered
    .map(area => profile.hitAreaMap?.[area] || area)
    .map(area => profile.interactions?.[area])
    .find((item): item is Live2DInteraction => Boolean(item)) ?? null
}

/**
 * 互动系统（拆分 Step 4 自 useLive2D.ts 原样搬出）：
 * 分区带命中 / 外框排序兜底 / 好感度动作调度 / 音效 / 叠层回落启动。
 * 监听解绑与互动计时清理仍由 destroyRuntime 统一执行（唯一复位路径）。
 */
export function createInteractionController(
  ctx: Live2DCtx,
  hooks: {
    setState: (state: Live2DStatus['state'], text: string, detail?: string, retryable?: boolean) => void
    resumeRendering: () => void
  },
) {
  function worldPoint(event: MouseEvent) {
    const canvas = ctx.session?.canvasElement?.() as HTMLCanvasElement | null
    const rect = canvas?.getBoundingClientRect() ?? ctx.stageEl?.getBoundingClientRect()
    if (!rect || !rect.width || !rect.height) return null
    const screen = ctx.session?.getScreenSize() ?? { width: 420, height: 610 }
    return {
      x: Math.max(0, Math.min(screen.width, (event.clientX - rect.left) / rect.width * screen.width)),
      y: Math.max(0, Math.min(screen.height, (event.clientY - rect.top) / rect.height * screen.height)),
    }
  }

  function interactionFromStagePosition(event: MouseEvent): Live2DInteraction | null {
    const rect = ctx.stageEl?.getBoundingClientRect()
    if (!rect?.width || !rect.height) return null
    const x = (event.clientX - rect.left) / rect.width
    const y = (event.clientY - rect.top) / rect.height
    return resolveStageInteraction(ctx.character.value, x, y)
  }

  function interactionAt(event: MouseEvent): Live2DInteraction | null {
    // The wl-live2d canvas is scaled and positioned inside the portrait card,
    // so its hitTest coordinates do not line up with the visible DOM stage.
    // Use the measured stage bands for user-facing semantics.
    const stageInteraction = interactionFromStagePosition(event)
    if (stageInteraction) return stageInteraction
    // wl-live2d sometimes reports the broad body mesh for every DOM click;
    // retain the measured hit areas only as a last-resort fallback.
    const point = worldPoint(event)
    const hitAreas = point && typeof ctx.model?.hitTest === 'function'
      ? ctx.model.hitTest(point.x, point.y)
      : []
    const interaction = resolveHitAreaInteraction(ctx.character.value, hitAreas)
    if (interaction) return interaction
    const fallbackId = ctx.adapter?.defaultInteractionId
    return (fallbackId && ctx.adapter?.interactions[fallbackId]) || null
  }

  function stopAudio() {
    if (ctx.interactionAudio) {
      try {
        ctx.interactionAudio.pause()
        ctx.interactionAudio.src = ''
      } catch {
        // ignore
      }
      ctx.interactionAudio = null
    }
  }

  function playNativeInteractionSound(soundUrl?: string) {
    if (!soundUrl || ctx.speaking || ctx.interactionVolume === 0) return
    try {
      stopAudio()
      const audio = new Audio()
      audio.crossOrigin = runtimeResourceCors() ?? null
      audio.src = resolveRuntimeUrl(soundUrl)
      audio.volume = ctx.interactionVolume
      ctx.interactionAudio = audio
      audio.play().catch(() => {
        // 浏览器静音策略或交互时机拦截静默降级
      })
      audio.onended = () => {
        if (ctx.interactionAudio === audio) ctx.interactionAudio = null
      }
    } catch {
      // ignore
    }
  }

  function markInteractionStarted(interaction: Live2DInteraction, customText?: string, soundUrl?: string) {
    ctx.activeInteraction = interaction.group
    clearTimeout(ctx.timers.interaction)
    // 互动计时结束只交还叠层参数所有权；复位改由 applyParameters 的所有权
    // 交接检测启动 smoothstep 回落（2026-08-23）。此处若先硬写会破坏回落
    // 对动作现值的捕获，退化回单帧硬切的"闪一下"。
    ctx.timers.interaction = window.setTimeout(() => {
      if (ctx.activeInteraction === interaction.group) {
        ctx.activeInteraction = ''
      }
    }, interaction.duration + 600)
    ctx.interactionHint.value = customText || interaction.hint
    hooks.setState('ready', 'Live2D 已连接')
    ctx.stageEl?.classList.remove('live2d-reacting')
    void ctx.stageEl?.offsetWidth
    ctx.stageEl?.classList.add('live2d-reacting')
    playNativeInteractionSound(soundUrl)
  }

  /**
   * 夏目叠层/换装参数的一次性硬复位（见 NATSUME_RESET_PARAMS）。正常路径
   * 已改用 beginNatsumeOverlaySettle 的 smoothstep 回落（2026-08-23 换装
   * 闪回修复）；本函数保留为运行库缺读参数接口时的降级，以及幂等兜底
   * （参数已是隐藏态时重复写无副作用）。复位值按隐藏态分组（0 / -1，
   * 2026-08-16 实证），统一写 0 会让 -1 组的参数落在"显示区间"，叠层
   * 半透明残留成重影。
   */
  function resetOverlayParams() {
    const overlay = ctx.adapter?.overlaySettle
    if (!overlay || !ctx.model || ctx.session?.capability.parameterOverride === false) return
    for (const [id, value] of Object.entries(overlay.resetDefaults)) {
      try { ctx.model.setParameterValueById(id, value, 1) } catch { /* 参数缺失忽略 */ }
    }
  }

  // 叠层/换装回落时长见 constants.OVERLAY_SETTLE_MS（与 applyParameters 共用）。

  /**
   * 开始一次夏目叠层/换装参数回落：捕获动作曲线留下的现值（换装显隐态），
   * 此后 applyParameters 每帧向隐藏态 smoothstep 缓动。运行库没有读参数
   * 接口时退回一次性硬写（旧行为）。原生端不适用（参数由 Rust 侧回落）。
   */
  function beginOverlaySettle() {
    const overlay = ctx.adapter?.overlaySettle
    if (!overlay || !ctx.model || ctx.session?.capability.parameterOverride === false) return
    const read = ctx.model.getParameterValueById
    if (typeof read !== 'function') {
      resetOverlayParams()
      return
    }
    const entries: Array<{ id: string; from: number; to: number }> = []
    for (const [id, value] of Object.entries(overlay.resetDefaults)) {
      const current = read.call(ctx.model, id)
      if (typeof current === 'number' && Number.isFinite(current)) {
        entries.push({ id, from: current, to: value })
      }
    }
    ctx.overlaySettle = entries.length ? { start: performance.now(), entries } : null
  }

  function interactionFailed(interaction: Live2DInteraction) {
    if (ctx.activeInteraction === interaction.group) {
      ctx.interactionHint.value = '这个动作正在进行中'
      return
    }
    ctx.interactionHint.value = '动作没有启动，请重试'
    hooks.setState('degraded', 'Live2D 动作未启动', `未能启动 ${interaction.group}`, true)
  }

  function playInteraction(interaction: Live2DInteraction) {
    if (!ctx.ready.value || !ctx.model?.visible || prefersReducedMotion() || ctx.mouthValue.value > 0) return
    // pixi-live2d-display uses the third argument as motion priority. Passing
    // null is treated as MotionPriority.NONE, which silently rejects the
    // motion while still letting the click hint update. FORCE interrupts idle
    // motion so a deliberate tap is always visible. We do not ship source WAVs;
    // this API does not need one for an authored motion to play.
    hooks.resumeRendering()
    if (typeof ctx.model.motion !== 'function') {
      interactionFailed(interaction)
      return
    }
    // 结合好感度调度系统按规则选择动作索引，并获取原装台词与加分反馈。
    // 基础调用契约保持 model.motion(interaction.group, undefined, 3) 兼容性
    const affection = useCompanionAffection()
    const dispatched = affection.dispatchInteractiveMotion(ctx.character.value, interaction.group)
    if (!dispatched && hasAffectionMotionRules(ctx.character.value, interaction.group)) {
      ctx.interactionHint.value = '这个互动尚未解锁，先多陪伴她一会儿吧'
      return
    }
    const motionIndex = dispatched?.index
    const customText = dispatched?.entry?.text
      ? `“${dispatched.entry.text}”${dispatched.bonusAwarded ? ` (好感度+${dispatched.bonusAwarded})` : ''}`
      : interaction.hint

    const soundUrl = dispatched?.entry?.sound
    const targetIndex = typeof motionIndex === 'number' ? motionIndex : undefined
    const result = ctx.model.motion(interaction.group, targetIndex, 3)
    if (isCatchable(result)) {
      result.then((started: unknown) => {
        if (started === true) markInteractionStarted(interaction, customText, soundUrl)
        else interactionFailed(interaction)
      }).catch((error: unknown) => {
        ctx.interactionHint.value = '动作暂时不可用，请重试'
        hooks.setState('degraded', 'Live2D 动作暂不可用', errorMessage(error), true)
      })
      return
    }
    if (result === true) markInteractionStarted(interaction, customText, soundUrl)
    else interactionFailed(interaction)
  }

  function bind() {
    if (!ctx.stageEl) return
    // 幂等重建：角色切换/重载会重建 session（onModelLoaded 再次进入），旧的
    // click 监听与 native 订阅必须解绑后重建，否则新 session 的 hit-test 回调
    // 无人接收（点击无任何反馈，2026-08-16 用户反馈"切换角色后无法点击"）。
    if (ctx.pointerClickHandler) {
      ctx.stageEl.removeEventListener('click', ctx.pointerClickHandler)
      ctx.pointerClickHandler = null
    }
    if (ctx.nativeHitTestUnsubscribe) { ctx.nativeHitTestUnsubscribe(); ctx.nativeHitTestUnsubscribe = null }
    if (ctx.nativeMotionFailedUnsubscribe) { ctx.nativeMotionFailedUnsubscribe(); ctx.nativeMotionFailedUnsubscribe = null }
    ctx.interactionHint.value = ctx.adapter?.interactionHint || '当前模型未配置点击互动'
    // 原生 overlay 位于透明 WebView 下方且不接收鼠标。舞台 DOM 保持完整交互，
    // 点击坐标归一化后交给 Rust 做 Cubism 原生 HitArea 命中。
    if (ctx.session?.capability.hitTestNative) {
      let point: { x: number; y: number } | null = null
      ctx.nativeHitTestUnsubscribe = ctx.session.onNativeHitTest?.((areas) => {
        const interaction = resolveHitAreaInteraction(ctx.character.value, areas)
          || (point ? resolveStageInteraction(ctx.character.value, point.x, point.y) : null)
        if (interaction) playInteraction(interaction)
      }) ?? null
      // 同一互动播放中重复点击：Rust 拒绝并回传 motion-failed，这里直接
      // 显示"动作进行中"（Rust 状态为准，前端 duration 计时可能已过期）。
      ctx.nativeMotionFailedUnsubscribe = ctx.session.onMotionFailed?.((info) => {
        if (/already playing/.test(info.reason)) {
          ctx.interactionHint.value = '这个动作正在进行中'
        }
      }) ?? null
      ctx.pointerClickHandler = (event) => {
        if ((event.target as HTMLElement | null)?.closest('button, a, input, select, textarea')) return
        const rect = ctx.hostEl?.getBoundingClientRect() || ctx.stageEl?.getBoundingClientRect()
        if (!rect?.width || !rect.height) return
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) return
        point = { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height }
        ctx.model?.hitTest(
          Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
          Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
        )
      }
      ctx.stageEl.addEventListener('click', ctx.pointerClickHandler)
      return
    }
    ctx.pointerClickHandler = (event) => {
      if ((event.target as HTMLElement | null)?.closest('button, a, input, select, textarea')) return
      const interaction = interactionAt(event)
      if (interaction) playInteraction(interaction)
    }
    ctx.stageEl.addEventListener('click', ctx.pointerClickHandler)
  }

  return { bind, stopAudio, beginOverlaySettle }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isCatchable(value: unknown): value is { catch(handler: (error: unknown) => void): unknown } {
  return isRecord(value) && typeof value.catch === 'function'
}
