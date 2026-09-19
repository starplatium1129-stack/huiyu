import { selectLive2DBackend } from '@/live2d/createBackend'
import { compileAdapterProfile } from '@/live2d/adapterProfile'
import { NATIVE_RENDER_STOPPED } from '@/live2d/nativeBackend'
import type {
  Live2DBackendKind,
  Live2DModelHandle,
  Live2DStageSession,
} from '@/live2d/types'
import { mediaStatusApi } from '@/api/mediaStatusApi'
import { live2DTextureScale, normalizeLive2DQuality } from '@/live2d/quality'
import { isStageHidden, prefersReducedMotion, type Live2DCtx, type Live2DStatus } from '@/composables/live2d/context'
import {
  ENTRANCE_MAX_MS,
  LEAVE_PLAY_MS,
} from '@/composables/live2d/constants'
import { isRecord, readLive2DCatalog, type Live2DModelInfo } from '@/composables/live2d/catalog'
import {
  normalizeCompanionOutfit,
  resolveCompanionAvatar,
} from '@/utils/companionRegistry'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isCatchable(value: unknown): value is { catch(handler: (error: unknown) => void): unknown } {
  return isRecord(value) && typeof value.catch === 'function'
}

/**
 * 生命周期域（拆分 Step 7 自 useLive2D.ts 原样搬出）：
 * init / load / enable / disable / retry / recover / setOutfit / setPaused /
 * destroyRuntime / destroy。
 * destroyRuntime 是全库唯一权威复位点——按冻结顺序（Pixi-first）清理
 * 4 个域的 timer、3 个 rAF 循环、适配器、参数表、DOM 类与 session/model，
 * 各子模块严禁自带清理副本。lifecycleToken 竞态卫兵语义不变，存于 ctx。
 */
export function createLifecycleController(
  ctx: Live2DCtx,
  controllers: {
    pointerGaze: { bind(): void }
    emotionClock: { start(): void; stop(): void }
    layoutFit: { fit(): void; layout(): void; scheduleNativeLayout(reset?: boolean): void; resetWindowBounds(): void }
    interactions: { bind(): void; stopAudio(): void }
    parameterFrame: { bindMouthOverride(): void }
  },
  hooks: {
    setState: (state: Live2DStatus['state'], text: string, detail?: string, retryable?: boolean) => void
  },
) {
  const setState = hooks.setState
  /**
   * 原生渲染线程停止（GPU 设备丢失 / swapchain 不可恢复）后的自动重试。
   * 桌宠是长期挂机场景，渲染挂掉时不应只留一个"点我重试"的按钮等人来点；
   * 这里退避重试最多 3 次（1.2s / 2.4s / 3.6s），成功（模型重新加载完成）后
   * 计数归零。超过上限则停在 retryable 状态交回用户，避免无效循环。
   */
  const NATIVE_STOPPED_RETRY_LIMIT = 3
  let nativeStoppedRetries = 0
  let nativeRetryTimer = 0
  let entranceTimer = 0
  let runtimeGeneration = 0
  let finishPendingLoad: ((value: boolean) => void) | null = null
  let pendingConnection: AbortController | null = null
  let requestedBackendKind: Live2DBackendKind = 'browser'
  function selectAdapter(char: string, backendKind = ctx.backendKind.value): boolean {
    const resolved = resolveCompanionAvatar(char)
    if (!resolved) {
      ctx.adapter = null
      ctx.adapterReport.value = null
      return false
    }
    if (backendKind === 'native' && !resolved.profile.backendCompatibility.includes('native')
      && resolved.profile.backendCompatibility.includes('browser')) {
      destroyRuntime()
      const selection = selectLive2DBackend('browser')
      ctx.backend = selection.backend
      ctx.backendKind.value = backendKind = 'browser'
      ctx.backendFallback.value = '此模型使用浏览器渲染'
      if (ctx.hostEl) ctx.hostEl.dataset.backend = 'browser-fallback'
    }
    const compiled = compileAdapterProfile(resolved.profile, backendKind)
    ctx.adapterReport.value = compiled.ok ? compiled.adapter.report : compiled.report
    ctx.adapter = compiled.ok ? compiled.adapter : null
    return compiled.ok
  }
  function scheduleNativeStoppedRetry() {
    if (ctx.destroyed.value || !ctx.enabled.value) return
    if (nativeRetryTimer) return
    if (nativeStoppedRetries >= NATIVE_STOPPED_RETRY_LIMIT) return
    nativeStoppedRetries += 1
    const delay = 1200 * nativeStoppedRetries
    nativeRetryTimer = window.setTimeout(() => {
      nativeRetryTimer = 0
      if (ctx.destroyed.value || !ctx.enabled.value || ctx.ready.value) return
      void retry()
    }, delay)
  }

  async function init(
    char: string,
    host: HTMLElement,
    stage: HTMLElement,
    options: { autoLoad?: boolean; outfit?: string; backendKind?: Live2DBackendKind } = {},
  ) {
    ctx.hostEl = host; ctx.stageEl = stage
    requestedBackendKind = options.backendKind || 'browser'
    // wl-live2d 只接受 CSS selector，这里保证宿主节点有稳定 id 可选中
    if (!ctx.hostEl.id) ctx.hostEl.id = 'live2dHost'
    ctx.hostSelector = '#' + ctx.hostEl.id
    if (!resolveCompanionAvatar(char)) {
      setState('static', '静态立绘', '角色或外观未在陪伴注册表登记')
      return
    }
    ctx.character.value = char
    controllers.pointerGaze.bind()
    ctx.outfit.value = normalizeCompanionOutfit(char, options.outfit || ctx.outfit.value)
    setState('checking', '检查 Live2D…')
    try {
      const catalog = readLive2DCatalog(await mediaStatusApi.getLive2DStatus())
      if (ctx.destroyed.value) return
      ctx.catalog = catalog
      const selection = selectLive2DBackend(options.backendKind)
      ctx.backend = selection.backend
      ctx.backendKind.value = selection.effectiveKind
      ctx.backendFallback.value = selection.fallbackReason
      if (!selectAdapter(char, selection.effectiveKind)) {
        setState('static', '静态立绘', `Live2D 适配配置不支持 ${selection.effectiveKind} 后端`)
        return
      }
      if (ctx.backendFallback.value) {
        if (ctx.hostEl) ctx.hostEl.dataset.backend = 'browser-fallback'
        console.warn('[live2d]', ctx.backendFallback.value)
      } else if (ctx.hostEl) {
        ctx.hostEl.dataset.backend = selection.effectiveKind
      }
      observeSize()
      bindVisibility()
      ctx.enabled.value = options.autoLoad === true
      if (ctx.enabled.value) await setCharacter(ctx.character.value)
      else {
        setVisible(false)
        setState('idle', '启用 Live2D', '点击后才下载并加载动态模型', true)
      }
    } catch (e) {
      if (ctx.destroyed.value) return
      fallback('Live2D 未就绪', errorMessage(e))
    }
  }

  function modelInfo(char: string) {
    const catalogInfo = ctx.catalog?.models?.[char]
    const registered = resolveCompanionAvatar(char)
    return catalogInfo && registered
      ? { ...catalogInfo, modelUrl: registered.avatar.modelPath }
      : null
  }

  async function setCharacter(char: string) {
    if (ctx.destroyed.value) return
    if (!resolveCompanionAvatar(char)) {
      destroyRuntime()
      ctx.adapter = null
      ctx.adapterReport.value = null
      setVisible(false)
      ctx.interactionHint.value = ''
      setState('static', '静态立绘', '角色或外观未在陪伴注册表登记')
      return
    }
    ctx.character.value = char
    if (requestedBackendKind === 'native' && ctx.backendKind.value === 'browser'
      && ctx.loadedCharacter.value !== char && resolveCompanionAvatar(char)?.profile.backendCompatibility.includes('native')) {
      destroyRuntime()
      const selection = selectLive2DBackend('native')
      ctx.backend = selection.backend
      ctx.backendKind.value = selection.effectiveKind
      ctx.backendFallback.value = selection.fallbackReason
      if (ctx.hostEl) ctx.hostEl.dataset.backend = selection.fallbackReason ? 'browser-fallback' : selection.effectiveKind
    }
    if (!selectAdapter(char)) {
      destroyRuntime()
      setVisible(false)
      ctx.interactionHint.value = ''
      setState('static', '静态立绘', `Live2D 适配配置不支持 ${ctx.backendKind.value} 后端`)
      return
    }
    const info = modelInfo(char)
    if (!info?.available || !info?.modelUrl) {
      destroyRuntime()
      setVisible(false)
      ctx.interactionHint.value = ''
      setState('static', '静态立绘', info?.source || '该角色暂无 Live2D 模型')
      return
    }
    if (!ctx.enabled.value) {
      setVisible(false)
      ctx.interactionHint.value = ''
      setState('idle', '启用 Live2D', '点击后才下载并加载动态模型', true)
      return
    }
    if (ctx.ready.value && ctx.loadedCharacter.value === char) {
      setVisible(true); setState('ready', 'Live2D 已连接')
      syncPause(); controllers.layoutFit.layout(); return
    }
    // A character switch can happen while the previous model is still loading.
    // Wait for that request to settle, then retry the character that is still
    // selected instead of returning the obsolete request's result.
    if (ctx.loading) await ctx.loading
    if (ctx.destroyed.value || !ctx.enabled.value || char !== ctx.character.value) return
    if (ctx.ready.value && ctx.loadedCharacter.value === char) {
      setVisible(true); setState('ready', 'Live2D 已连接')
      syncPause(); controllers.layoutFit.layout(); return
    }
    await load(char, info)
  }

  async function retry() {
    if (ctx.destroyed.value) return
    if (ctx.loading) return ctx.loading
    if (!ctx.enabled.value) return enable()
    destroyRuntime()
    await setCharacter(ctx.character.value)
  }

  async function enable() {
    if (ctx.destroyed.value) return false
    ctx.lifecycleToken += 1
    clearTimeout(ctx.timers.leave)
    ctx.timers.leave = 0
    ctx.enabled.value = true
    return setCharacter(ctx.character.value)
  }

  async function setQuality(value: string) {
    const quality = normalizeLive2DQuality(value)
    if (quality === ctx.quality.value || ctx.destroyed.value) return
    ctx.quality.value = quality
    if (!ctx.enabled.value) return
    destroyRuntime()
    await setCharacter(ctx.character.value)
  }

  function disable() {
    const token = ++ctx.lifecycleToken
    ctx.enabled.value = false
    ctx.interactionHint.value = ''
    // 告别动作：先播一小段 Leave 再销毁，避免"切换回静态立绘"瞬间硬切。
    // 减少动态效果或动作不可用时直接销毁；告别期间再次点击可立即重载。
    const leaveGroup = ctx.adapter?.leaveGroup
    const playable = leaveGroup && ctx.ready.value && ctx.model && typeof ctx.model.motion === 'function' && !prefersReducedMotion()
      ? ctx.model.motion(leaveGroup, undefined, 3)
      : null
    const started = isCatchable(playable) ? playable.then((v: unknown) => v === true).catch(() => false) : Promise.resolve(playable === true)
    void started.then((ok: boolean) => {
      if (token !== ctx.lifecycleToken || ctx.enabled.value) return
      if (!ok) {
        destroyRuntime()
        setState('idle', '启用 Live2D', '动态模型已释放；点击可重新加载', true)
        return
      }
      resumeRendering()
      setState('idle', '正在道别…', '播放告别动作后释放资源', false)
      clearTimeout(ctx.timers.leave)
      ctx.timers.leave = window.setTimeout(() => {
        if (token !== ctx.lifecycleToken || ctx.enabled.value) return
        destroyRuntime()
        setState('idle', '启用 Live2D', '动态模型已释放；点击可重新加载', true)
      }, LEAVE_PLAY_MS)
    })
  }

  function load(char: string, info: Live2DModelInfo): Promise<boolean> {
    if (ctx.loading) return ctx.loading
    if (!ctx.backend) return Promise.resolve(false)
    // connect 会创建 canvas，必须先释放旧会话，再启动新连接。
    destroyRuntime()
    ctx.loading = new Promise((resolve) => {
      void (async () => {
        const generation = runtimeGeneration
        const connection = new AbortController()
        pendingConnection = connection
        let settled = false
        const finish = (v: boolean) => {
          if (settled) return
          settled = true
          if (finishPendingLoad === finish) {
            finishPendingLoad = null
            clearTimeout(ctx.timers.load)
            ctx.timers.load = 0
            ctx.loading = null
          }
          resolve(v)
        }
        finishPendingLoad = finish
        // 连接（含原生模型加载）与首帧共用截止时间，不能等 connect 返回后才计时。
        ctx.timers.load = window.setTimeout(() => { destroyRuntime(); fallback('Live2D 加载超时', '模型在 20 秒内没有完成初始化') }, 20000)
        const isCurrent = () => generation === runtimeGeneration && !ctx.destroyed.value
          && ctx.enabled.value && char === ctx.character.value
        if (ctx.hostEl) ctx.hostEl.innerHTML = ''
        // 加载状态必须在 connect 之前显示：原生后端 setCharacter 在渲染线程
        // 加载模型与纹理可能耗时数秒，期间 UI 线程保持空闲，loading 立即可见。
        setState('loading', 'Live2D 加载中…')
        let nextSession: Live2DStageSession
        try {
          nextSession = await ctx.backend!.connect({
            signal: connection.signal,
            selector: ctx.hostSelector,
            modelUrl: ctx.backendKind.value === 'browser' && ctx.quality.value !== 'original'
              ? `/api/live2d-model/${char}/${ctx.quality.value}` : info.modelUrl,
            textureScale: live2DTextureScale(ctx.quality.value),
            canvasWidth: info.canvas?.width || 420,
            canvasHeight: info.canvas?.height || 610,
            character: char,
            adapter: ctx.adapter || undefined,
          })
        } catch (e) {
          if (!isCurrent()) { finish(false); return }
          const message = errorMessage(e)
          // 原生 IPC、GPU 或模型初始化任一步失败，都回退浏览器后端再试一次。
          if (ctx.backendKind.value === 'native' && ctx.backend?.kind === 'native') {
            const selection = selectLive2DBackend('browser')
            ctx.backend = selection.backend
            ctx.backendKind.value = 'browser'
            if (!selectAdapter(char, 'browser')) {
              fallback('Live2D 适配失败', '当前 Profile 不支持原生回退后的浏览器后端')
              finish(false); return
            }
            ctx.backendFallback.value = `原生 Live2D 初始化失败，已回退到浏览器渲染：${message}`
            if (ctx.hostEl) ctx.hostEl.dataset.backend = 'browser-fallback'
            console.warn('[live2d]', ctx.backendFallback.value)
            try {
              nextSession = await ctx.backend!.connect({
                signal: connection.signal,
                selector: ctx.hostSelector,
                modelUrl: ctx.quality.value !== 'original' ? `/api/live2d-model/${char}/${ctx.quality.value}` : info.modelUrl,
                textureScale: live2DTextureScale(ctx.quality.value),
                canvasWidth: info.canvas?.width || 420,
                canvasHeight: info.canvas?.height || 610,
                character: char,
                adapter: ctx.adapter || undefined,
              })
            } catch (e2) {
              if (isCurrent()) fallback('Live2D 初始化失败', errorMessage(e2))
              finish(false); return
            }
          } else {
            fallback('Live2D 初始化失败', message)
            finish(false); return
          }
        }
        if (!isCurrent()) {
          nextSession.destroy()
          finish(false); return
        }
        if (pendingConnection === connection) pendingConnection = null
        ctx.session = nextSession
        const nativeCapability = ctx.session.kind === 'native' ? ctx.session.capability : null
        ctx.session.onModelLoaded((m: Live2DModelHandle) => {
          if (!isCurrent()) { finish(false); return }
          if (settled) return
          ctx.model = m; ctx.loadedCharacter.value = char; ctx.ready.value = true
          ctx.session?.setMaxFps(ctx.maxFps)
          // 模型重新加载成功 = 渲染已恢复（含自动重试路径），清零重试计数
          nativeStoppedRetries = 0
          ctx.mouthValue.value = 0; ctx.mouthHooked = false
          controllers.parameterFrame.bindMouthOverride(); bindContextEvents(); controllers.interactions.bind(); controllers.layoutFit.fit(); controllers.layoutFit.scheduleNativeLayout()
          setVisible(true); syncPause(); setState('ready', 'Live2D 已连接')
          // Absolute companion stages do not resize when a model arrives. Fit after
          // visibility is enabled, otherwise the hidden-stage guard skips centering.
          controllers.layoutFit.layout()
          if (!nativeCapability?.entranceNative) playEntrance()
          void setOutfit(ctx.outfit.value)
          finish(true)
        })
        ctx.session.onModelError((e: Error) => {
          if (!isCurrent()) return
          const detail = errorMessage(e)
          // 原生渲染线程停止：overlay 已销毁，模型不可用，必须提示并允许
          // 重试重新拉起线程（与"动作/换装失败但模型仍显示"的退化不同）。
          if (e.name === NATIVE_RENDER_STOPPED) {
            destroyRuntime()
            setState('degraded', 'Live2D 渲染已停止', detail, true)
            scheduleNativeStoppedRetry()
            return
          }
          // wl-live2d 复用这一个回调报告初始载入和之后的 outfit/motion
          // 错误。后者不代表已经显示的模型失效，不能因此切回静态立绘。
          if (ctx.ready.value && ctx.loadedCharacter.value === char) {
            setState('degraded', 'Live2D 动作或换装暂不可用', detail, true)
            return
          }
          fallback('Live2D 模型加载失败', detail); finish(false)
        })
      })()
    })
    return ctx.loading
  }

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
    ctx.motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
    ctx.motionPreferenceHandler = syncPause
    ctx.motionQuery.addEventListener?.('change', ctx.motionPreferenceHandler)
  }

  function playEntrance() {
    if (prefersReducedMotion()) return
    if (!ctx.model) return
    const motionFn = ctx.model.motion
    const generation = runtimeGeneration
    if (typeof motionFn !== 'function') return
    // 浏览器路径：从 wl-live2d 的 motionManager.definitions 探测 Start 组
    // （原生后端由 Rust 接管入场动作，不会走到这里）。
    const entranceGroup = ctx.adapter?.entranceGroup
    if (!entranceGroup || !(ctx.model.hasMotionGroup?.(entranceGroup) ?? false)) return
    // 模型刚加载完成时 Start 组的动作可能还在预加载，startRandomMotion 会
    // 因组内全部未就绪直接返回 false；这里重试直到登场动作真正启动。
    let attempts = 0
    const tryStart = () => {
      if (attempts++ > 40 || generation !== runtimeGeneration || !ctx.enabled.value || ctx.destroyed.value || !ctx.model) return
      const result = motionFn.call(ctx.model, entranceGroup, undefined, 2)
      const started = isCatchable(result)
        ? result.then((v: unknown) => v === true).catch(() => false)
        : Promise.resolve(result === true)
      void started.then((ok: boolean) => {
        if (generation !== runtimeGeneration || !ctx.enabled.value || ctx.destroyed.value) return
        if (ok) {
          ctx.entranceUntil = performance.now() + ENTRANCE_MAX_MS
          // 登场结束后（entranceUntil 过期）叠层参数由 parameterFrame.apply 的
          // 所有权交接自动启动 smoothstep 回落：Start* 变体也会驱动叠层
          // 显隐（2026-08-16 实测 Start_1 等把 Param38 等从 0 拉高），
          // idle 不带回，残留会成半透明重影。
          return
        }
        entranceTimer = window.setTimeout(tryStart, 250)
      })
    }
    tryStart()
  }

  function bindContextEvents() {
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

  function resumeRendering() {
    if (!ctx.session || isStageHidden(ctx) || prefersReducedMotion()) return
    ctx.session.setMaxFps(ctx.maxFps)
    ctx.session.setPaused(false)
    controllers.emotionClock.start()
    controllers.layoutFit.layout()
  }

  function setPaused(paused: boolean) {
    ctx.desktopVisible = !paused
    syncPause()
  }

  function syncPause() {
    if (!ctx.session) return
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

  async function recover() {
    if (ctx.destroyed.value || !ctx.enabled.value || isStageHidden(ctx)) return
    if (ctx.loading) await ctx.loading
    if (ctx.destroyed.value || !ctx.enabled.value || isStageHidden(ctx)) return
    if (!ctx.ready.value || !ctx.model || ctx.loadedCharacter.value !== ctx.character.value) {
      await retry()
      return
    }
    setVisible(true)
    syncPause()
    controllers.layoutFit.layout()
  }

  function setVisible(value: boolean) {
    const visible = Boolean(value && ctx.ready.value && ctx.loadedCharacter.value === ctx.character.value)
    ctx.stageEl?.classList.toggle('live2d-ready', visible)
    if (ctx.model) ctx.model.visible = visible
    if (!visible && ctx.session?.capability.parameterOverride === false) ctx.session.setPaused(true)
  }

  async function setOutfit(id: string): Promise<boolean> {
    const targetId = normalizeCompanionOutfit(ctx.character.value, id)
    const avatar = resolveCompanionAvatar(ctx.character.value)?.avatar
    const target = avatar?.outfits?.find(outfit => outfit.id === targetId)
    if (!target) return false
    ctx.outfit.value = target.id
    // 无 expression 的外观由模型本身或作者 motion 管理，不伪造换装能力。
    if (!target.expression) return true
    if (!ctx.ready.value || !ctx.model?.visible) return true
    if (typeof ctx.model.expression !== 'function') {
      setState('degraded', 'Live2D 换装暂不可用', '当前运行库未提供 Expression 接口', true)
      return false
    }
    try {
      resumeRendering()
      const started = await Promise.resolve(ctx.model.expression(target.expression))
      if (started === false) {
        setState('degraded', 'Live2D 换装未完成', `模型拒绝了 ${target.label} Expression`, true)
        return false
      }
      setState('ready', 'Live2D 已连接')
      return true
    } catch (error) {
      setState('degraded', 'Live2D 换装暂不可用', errorMessage(error), true)
      return false
    }
  }

  function fallback(text: string, detail: string) {
    controllers.interactions.stopAudio()
    ctx.ready.value = false; ctx.mouthValue.value = 0; ctx.interactionHint.value = ''; setVisible(false)
    setState('fallback', text || '静态立绘', detail || '', true)
  }

  function destroyRuntime() {
    runtimeGeneration += 1
    pendingConnection?.abort()
    pendingConnection = null
    clearTimeout(nativeRetryTimer); nativeRetryTimer = 0
    clearTimeout(entranceTimer); entranceTimer = 0
    finishPendingLoad?.(false)
    controllers.interactions.stopAudio()
    clearTimeout(ctx.timers.load); ctx.timers.load = 0
    clearTimeout(ctx.timers.interaction); ctx.timers.interaction = 0; ctx.activeInteraction = ''
    clearTimeout(ctx.timers.leave); ctx.timers.leave = 0
    controllers.emotionClock.stop()
    if (ctx.frames.nativeLayout) window.cancelAnimationFrame(ctx.frames.nativeLayout)
    ctx.frames.nativeLayout = 0
    ctx.nativeLayoutAttempts = 0
    if (ctx.frames.gaze) window.cancelAnimationFrame(ctx.frames.gaze)
    ctx.frames.gaze = 0
    ctx.gaze.lastFrame = 0
    ctx.entranceUntil = 0
    ctx.overlaySettle = null
    ctx.overlayWasByMotion = false
    // Stop Pixi before clearing model state. Otherwise an authored motion can
    // tick once during character switching and read arrays already released by
    // wl-live2d's destroy path.
    const currentSession = ctx.session
    const currentModel = ctx.model
    if (currentSession) currentSession.setPaused(true)
    if (currentModel) currentModel.visible = false
    ctx.ready.value = false; ctx.mouthValue.value = 0; ctx.mouthHooked = false; ctx.speaking = false
    for (const key of Object.keys(ctx.emotionCurrent)) delete ctx.emotionCurrent[key]
    ctx.expressionParamIds.clear()
    ctx.nativeAnimationAdapter.reset()
    ctx.blinkScheduler.reset()
    ctx.lastParamFrame = 0
    ctx.loadedCharacter.value = ''
    ctx.stageEl?.classList.remove('live2d-ready')
    if (ctx.nativeHitTestUnsubscribe) { ctx.nativeHitTestUnsubscribe(); ctx.nativeHitTestUnsubscribe = null }
    if (ctx.nativeMotionFailedUnsubscribe) { ctx.nativeMotionFailedUnsubscribe(); ctx.nativeMotionFailedUnsubscribe = null }
    if (currentSession && typeof currentSession.destroy === 'function') { try { currentSession.destroy() } catch {} }
    ctx.model = null
    ctx.session = null
    ctx.gaze.currentX = 0
    ctx.gaze.currentY = 0
    ctx.gaze.x = 0
    ctx.gaze.y = 0
    ctx.gaze.active = false
    ctx.gaze.kind = 'idle'
    ctx.nativeOverlayReady = false
    if (ctx.hostEl) ctx.hostEl.innerHTML = ''
  }

  function destroy() {
    ctx.lifecycleToken += 1
    ctx.destroyed.value = true; ctx.enabled.value = false; destroyRuntime()
    ctx.adapter = null
    ctx.adapterReport.value = null
    controllers.layoutFit.resetWindowBounds()
    ctx.resizeObserver?.disconnect()
    if (ctx.onResize) window.removeEventListener('resize', ctx.onResize)
    if (ctx.visibilityHandler) { document.removeEventListener('visibilitychange', ctx.visibilityHandler); ctx.visibilityHandler = null }
    if (ctx.motionPreferenceHandler) ctx.motionQuery?.removeEventListener?.('change', ctx.motionPreferenceHandler)
    ctx.motionQuery = null; ctx.motionPreferenceHandler = null
    if (ctx.stageEl && ctx.pointerClickHandler) ctx.stageEl.removeEventListener('click', ctx.pointerClickHandler)
    if (ctx.stageEl && ctx.pointerGazeHandler) ctx.stageEl.removeEventListener('mousemove', ctx.pointerGazeHandler)
    if (ctx.stageEl && ctx.pointerGazeLeaveHandler) ctx.stageEl.removeEventListener('mouseleave', ctx.pointerGazeLeaveHandler)
    ctx.pointerClickHandler = null
    ctx.pointerGazeHandler = null
    ctx.pointerGazeLeaveHandler = null
  }

  return { init, setCharacter, enable, disable, retry, recover, setOutfit, setQuality, setPaused, resumeRendering, fallback, destroy }
}
