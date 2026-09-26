import { getNativeLive2dCapabilities } from '../platform/desktop/nativeLive2d.ts'
/**
 * 原生渲染后端 —— Rust overlay 窗口 + Cubism Native（路径 B）。
 *
 * 前端经 getNativeLive2dCapabilities() 桥与 Rust 通信：Rust 在透明 WS_EX_LAYERED
 * overlay 窗口上用 wgpu 呈现 Live2D，模型由 Cubism Native 官方运行时执行
 * motion/physics/pose/expression/hit-test。前端只传"意图"（口型电平、
 * 情绪名称/强度、动作组请求、overlay 矩形），不做参数级写入。
 *
 * 桥不存在时 connect 必须 reject（错误名 NATIVE_BACKEND_UNAVAILABLE），
 * useLive2D 据此 fallback 到浏览器后端。
 */

import {
  NATIVE_BACKEND_UNAVAILABLE,
  NATIVE_CAPABILITY,
  type Live2DConnectOptions,
  type Live2DModelHandle,
  type Live2DStageBackend,
  type Live2DStageSession,
} from './types.ts'
import type { Live2DMotionPriority, Live2DNativeBridge } from '../types/live2dNative.ts'
import { createLatestIntent } from './latestIntent.ts'

/**
 * 原生渲染线程停止错误名。useLive2D 依此区分"渲染线程退出"与普通模型
 * 错误：前者 overlay 不可用，应显示错误并可重试重新拉起线程。
 */
export const NATIVE_RENDER_STOPPED = 'NATIVE_RENDER_STOPPED'

export type NativeBridgeProvider = () => Live2DNativeBridge | null | undefined

function defaultBridgeProvider(): Live2DNativeBridge | null | undefined {
  if (typeof window === 'undefined') return undefined
  return getNativeLive2dCapabilities()
}

const PRIORITY_MAP: Record<number, Live2DMotionPriority> = {
  1: 'idle',
  2: 'normal',
  3: 'force',
}

async function connectCharacter(bridge: Live2DNativeBridge, options: Live2DConnectOptions) {
  const signal = options.signal
  signal?.throwIfAborted()
  let cancel: (() => void) | undefined
  const cancelled = new Promise<never>((_, reject) => {
    cancel = () => {
      // 立即把清理排在当前加载之后、新连接之前；迟到的响应不再销毁新模型。
      void bridge.destroy().catch(() => {})
      reject(signal?.reason ?? new Error('Live2D 连接已取消'))
    }
    signal?.addEventListener('abort', cancel, { once: true })
  })
  try {
    return await Promise.race([
      bridge.setCharacter(options.modelUrl, { character: options.character || 'nene',
        ...(bridge.supportsTextureQuality ? { textureScale: options.textureScale ?? 1 } : {}),
        ...(options.adapter ? { adapter: options.adapter } : {}),
      }),
      cancelled,
    ])
  } finally {
    if (cancel) signal?.removeEventListener('abort', cancel)
  }
}

export function createNativeLive2DBackend(provider: NativeBridgeProvider = defaultBridgeProvider): Live2DStageBackend {
  return {
    kind: 'native',
    capability: NATIVE_CAPABILITY,

    async connect(options: Live2DConnectOptions): Promise<Live2DStageSession> {
      const bridge = provider()
      if (!bridge) {
        throw new Error(NATIVE_BACKEND_UNAVAILABLE)
      }
      const result = await connectCharacter(bridge, options)
      if (!result.ok) {
        throw new Error(`原生 Live2D 加载失败：${result.error ?? '未知错误'}`)
      }

      let destroyed = false
      let lastRect: { x: number; y: number; width: number; height: number } = { x: 0, y: 0, width: 0, height: 0 }
      let lastVisible = false
      let framing = { zoom: 1, x: 0, y: 0 }
      let gazeInFlight = false
      let queuedGaze: { x: number; y: number } | null = null
      let streamsPaused = false
      let emotionName = ''
      const unit = (value: number) => Number.isFinite(value) ? Math.round(Math.max(0, Math.min(1, value)) * 1000) / 1000 : 0
      const mouthIntent = createLatestIntent<number>(value => bridge.setMouthLevel(value), Object.is, 16)
      const emotionIntent = createLatestIntent<{ name: string; intensity: number }>(
        value => bridge.setEmotion(value.name, value.intensity),
        (a, b) => a.name === b.name && a.intensity === b.intensity, 50,
      )
      const hitTestListeners = new Set<(areas: string[]) => void>()
      const motionStartedListeners = new Set<() => void>()
      const motionFailedListeners = new Set<(info: { group: string; index?: number; reason: string }) => void>()
      const errorListeners = new Set<(error: Error) => void>()

      // 已下发过的帧参数。setPaused(false) 会被高频重复调用（说话时口型回调
      // 每帧走 resumeRendering），不去重就会每帧发一次 setFrame，让 Rust 每帧
      // 执行 ShowWindow + SetWindowPos——透明 overlay 窗口被反复重设会表现成
      // 表面抖动。参数未变时整条 IPC 直接跳过，位置同步不依赖它（Rust 侧自己
      // 按 Companion HWND 跟随）。2026-08-30 桌宠表面闪烁修复。
      let pushedFrame: { rect: { x: number; y: number; width: number; height: number }; visible: boolean } | null = null
      let pushedFps: { value: number } | null = null
      const pushFrame = () => {
        if (destroyed) return
        if (
          pushedFrame
          && pushedFrame.visible === lastVisible
          && pushedFrame.rect.x === lastRect.x
          && pushedFrame.rect.y === lastRect.y
          && pushedFrame.rect.width === lastRect.width
          && pushedFrame.rect.height === lastRect.height
        ) return
        const frame = { rect: { ...lastRect }, visible: lastVisible }
        pushedFrame = frame
        void Promise.resolve(bridge.setFrame({ ...frame, opacity: 1, ...(bridge.supportsFraming ? { framing } : {}) })).catch(() => {
          // 只撤销失败请求自己的缓存，旧失败不能覆盖较新的成功更新。
          if (pushedFrame === frame) pushedFrame = null
        })
      }

      const pushGaze = (x: number, y: number) => {
        if (destroyed || streamsPaused) return
        if (gazeInFlight) {
          queuedGaze = { x, y }
          return
        }
        gazeInFlight = true
        void Promise.resolve(bridge.setGaze(x, y))
          .catch(() => {})
          .finally(() => {
            gazeInFlight = false
            const next = queuedGaze
            queuedGaze = null
            if (next) pushGaze(next.x, next.y)
          })
      }

      const subscriptions: number[] = []
      subscriptions.push(bridge.onHitTest((areas) => {
        if (destroyed) return
        for (const listener of hitTestListeners) listener(areas)
      }))
      subscriptions.push(bridge.onMotionStarted(() => {
        if (destroyed) return
        for (const listener of motionStartedListeners) listener()
      }))
      subscriptions.push(bridge.onMotionFailed((info) => {
        if (destroyed) return
        for (const listener of motionFailedListeners) listener(info)
      }))
      // 渲染线程停止（异常退出/通道断开/窗口销毁）：overlay 与模型不可用，
      // 转发给 useLive2D 的错误回调；重试会重新拉起线程（ensure_overlay）。
      subscriptions.push(bridge.onStopped((info) => {
        if (destroyed) return
        const error = new Error(`原生渲染线程已停止：${info?.reason ?? '未知原因'}`)
        error.name = NATIVE_RENDER_STOPPED
        for (const listener of errorListeners) listener(error)
      }))

      const handle: Live2DModelHandle = {
        visible: true,
        motion(group, index, priority) {
          if (destroyed) return false
          return bridge.playMotion(group, index, PRIORITY_MAP[priority ?? 3] ?? 'force')
            .then((result) => result.ok)
            .catch(() => false)
        },
        expression(name) {
          if (destroyed) return false
          return bridge.setExpression(name)
            .then((result) => result.ok)
            .catch(() => false)
        },
        hitTest(x, y) {
          if (destroyed) return []
          void bridge.hitTest(x, y).then((result) => {
            if (!destroyed) for (const listener of hitTestListeners) listener(result.areas)
          }).catch(() => { /* 窗口关闭或桥断开时忽略已失效的点击查询 */ })
          return []
        },
        focus() { /* 原生端凝视由 Rust 经 setGaze 驱动，桌面场景用全局鼠标 */ },
        setParameterValueById() { /* 原生端不做参数写入（capability.parameterOverride=false） */ },
        onBeforeModelUpdate() { /* 原生端由 Cubism Native 帧循环执行作者工程 */ },
        applyFit() { /* 原生端尺寸由 overlay 帧控制（setFrame） */ },
        getNaturalSize() { return { width: options.canvasWidth, height: options.canvasHeight } },
        hasMotionGroup() { return false },
      }

      const session: Live2DStageSession = {
        kind: 'native',
        capability: NATIVE_CAPABILITY,
        onModelLoaded(callback) {
          // setCharacter resolves only after the render thread loaded the model.
          // A ready event emitted during that command is not replayed to listeners
          // registered afterward, so command success is the durable ready signal.
          if (!destroyed) callback(handle)
        },
        onModelError(callback) {
          if (destroyed) return
          errorListeners.add(callback)
        },
        setPaused(paused) {
          if (destroyed) return
          if (paused && !streamsPaused) {
            emotionIntent.clear()
            mouthIntent.clear()
            mouthIntent.push(0, true)
            queuedGaze = null
          }
          streamsPaused = paused
          lastVisible = !paused
          pushFrame()
        },
        setMaxFps(fps) {
          if (destroyed) return
          // 原生渲染线程接电目标 165fps；上限放行到 165，不被浏览器 120 限制。
          const value = Math.max(24, Math.min(165, Math.round(fps) || 60))
          if (pushedFps?.value === value) return
          const request = { value }
          pushedFps = request
          void Promise.resolve(bridge.setMaxFps(value)).catch(() => {
            if (pushedFps === request) pushedFps = null
          })
        },
        getScreenSize() { return { width: options.canvasWidth, height: options.canvasHeight } },
        getCanvasSize() { return { width: options.canvasWidth, height: options.canvasHeight } },
        setStageScale() { /* overlay 尺寸由 live2dOverlayLayout 计算后经 updateOverlay 下发 */ },
        updateOverlay(rect, visible, view) {
          if (destroyed) return
          if (view && (view.zoom !== framing.zoom || view.x !== framing.x || view.y !== framing.y)) { framing = view; pushedFrame = null }
          lastRect = { ...rect }
          lastVisible = visible
          pushFrame()
        },
        canvasElement() { return null },
        onNativeHitTest(callback) {
          if (destroyed) return () => {}
          hitTestListeners.add(callback)
          return () => { hitTestListeners.delete(callback) }
        },
        onMotionFailed(callback) {
          if (destroyed) return () => {}
          motionFailedListeners.add(callback)
          return () => { motionFailedListeners.delete(callback) }
        },
        sendMouthLevel(level) {
          if (destroyed || streamsPaused) return
          const value = unit(level)
          mouthIntent.push(value, value === 0)
        },
        sendEmotion(name, intensity) {
          if (destroyed || streamsPaused) return
          emotionIntent.push({ name, intensity: unit(intensity) }, name !== emotionName)
          emotionName = name
        },
        sendGaze(x, y) {
          pushGaze(Math.max(-1, Math.min(1, x)), Math.max(-1, Math.min(1, y)))
        },
        destroy() {
          if (destroyed) return
          destroyed = true
          mouthIntent.dispose()
          emotionIntent.dispose()
          queuedGaze = null
          hitTestListeners.clear()
          motionStartedListeners.clear()
          motionFailedListeners.clear()
          errorListeners.clear()
          for (const id of subscriptions) bridge.off(id)
          subscriptions.length = 0
          void bridge.destroy().catch(() => { /* 析构期忽略 */ })
        },
      }
      return session
    },
  }
}
