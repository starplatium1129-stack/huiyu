/**
 * 浏览器渲染后端 —— wl-live2d（Pixi + Cubism Web）。
 *
 * 从 useLive2D 原实现平移，行为零改动：动态 import 运行库、创建 app、
 * 模型句柄包装、Pixi ticker 控制、wrapper 缩放与 canvas 测量。
 */

import {
  BROWSER_CAPABILITY,
  type Live2DConnectOptions,
  type Live2DModelHandle,
  type Live2DStageBackend,
  type Live2DStageSession,
} from './types.ts'

interface Live2DCoreModel {
  setParameterValueById?(id: string, value: number, weight: number): void
  getParameterValueById?(id: string): number
  setParamFloat?(id: string, value: number, weight: number): void
  getParamFloat?(id: string): number
}

interface WlLive2DModel {
  autoUpdate?: boolean
  update?(deltaMs: number): void
  visible: boolean
  width: number
  height: number
  x: number
  y: number
  scale: { x: number; y: number; set(value: number): void }
  internalModel?: {
    on(event: 'beforeModelUpdate', callback: () => void): void
    coreModel?: Live2DCoreModel
    settings?: { hitAreas?: unknown[] }
    motionManager?: { definitions?: Record<string, unknown>; state?: { currentGroup?: string }; expressionManager?: {
      resetExpression?(): void; currentExpression?: unknown; defaultExpression?: unknown
    } }
  }
  hitTest?(x: number, y: number): string[]
  focus?(x: number, y: number, instant?: boolean): void
  motion?(group: string, index?: number, priority?: number): Promise<boolean> | boolean
  expression?(name: string): Promise<boolean> | boolean
}

interface WlLive2DApp {
  app?: {
    render?(): void
    screen?: { width: number; height: number }
    ticker?: {
      started: boolean
      maxFPS?: number
      deltaMS?: number
      add?(callback: () => void, context?: unknown, priority?: number): void
      remove?(callback: () => void): void
      start(): void
      stop(): void
    }
  }
  onModelLoaded(callback: (model: WlLive2DModel) => void): void
  onModelError(callback: (error: Error) => void): void
  destroy(): void
}

type WlLive2DFactory = (options: Record<string, unknown>) => WlLive2DApp
interface WlLive2DLibrary { wlLive2d: WlLive2DFactory }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readLibrary(value: unknown): WlLive2DLibrary | null {
  if (typeof value === 'function') return { wlLive2d: value as WlLive2DFactory }
  if (!isRecord(value)) return null
  if (typeof value.wlLive2d === 'function') return { wlLive2d: value.wlLive2d as WlLive2DFactory }
  return readLibrary(value.default)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 包装 wl-live2d model 为统一句柄（原 useLive2D 中对 model 的全部操作都在这里） */
function wrapModel(model: WlLive2DModel): Live2DModelHandle {
  return {
    get visible() { return model.visible },
    set visible(value: boolean) { model.visible = value },
    motion(group, index, priority) {
      if (typeof model.motion !== 'function') return false
      return model.motion(group, index, priority)
    },
    expression(name) {
      if (!name) {
        const manager = model.internalModel?.motionManager?.expressionManager
        if (!manager?.resetExpression) return false
        manager.currentExpression = manager.defaultExpression
        manager.resetExpression()
        return true
      }
      if (typeof model.expression !== 'function') return false
      return model.expression(name)
    },
    hitTest(x, y) {
      if (typeof model.hitTest !== 'function') return []
      return model.hitTest(x, y)
    },
    focus(x, y) {
      if (typeof model.focus !== 'function') return
      model.focus(x, y)
    },
    setParameterValueById(id, value, weight) {
      const core = model.internalModel?.coreModel
      const write = core?.setParameterValueById || core?.setParamFloat
      write?.call(core, id, value, weight)
    },
    getParameterValueById(id) {
      const read = model.internalModel?.coreModel?.getParameterValueById || model.internalModel?.coreModel?.getParamFloat
      return typeof read === 'function' ? read.call(model.internalModel?.coreModel, id) : undefined
    },
    onBeforeModelUpdate(callback) {
      model.internalModel?.on('beforeModelUpdate', callback)
    },
    applyFit(scale, x, y) {
      try {
        model.scale.set(scale)
        model.x = x
        model.y = y
      } catch {
        // 与 useLive2D fit() 的 try/catch 语义一致：布局失败不打断主流程
      }
    },
    getNaturalSize() {
      const sx = model.scale?.x || 1
      const sy = model.scale?.y || 1
      return { width: model.width / sx, height: model.height / sy }
    },
    hasMotionGroup(group) {
      const defs = model.internalModel?.motionManager?.definitions
      const entry = defs?.[group]
      return Array.isArray(entry) && entry.length > 0
    },
    getActiveMotionGroup() {
      const state = model.internalModel?.motionManager?.state
      return state ? state.currentGroup ?? null : undefined
    },
  }
}

export function createBrowserLive2DBackend(): Live2DStageBackend {
  return {
    kind: 'browser',
    capability: BROWSER_CAPABILITY,

    async connect(options: Live2DConnectOptions): Promise<Live2DStageSession> {
      const library = await loadLibrary()
      options.signal?.throwIfAborted()
      if (typeof document === 'undefined') throw new Error('wl-live2d 需要浏览器 DOM')
      let app: WlLive2DApp
      let modelHandle: Live2DModelHandle | null = null
      let destroyed = false
      let paused = false
      let rendered = false
      let rawModel: WlLive2DModel | null = null
      let screenSize = { width: options.canvasWidth, height: options.canvasHeight }
      // Own the model clock together with rendering. The library otherwise
      // advances it on Pixi's shared ticker even while this app is paused.
      const advanceModel = () => {
        if (destroyed || paused || !rawModel) return
        rawModel.update?.(Math.min(100, app.app?.ticker?.deltaMS ?? 1000 / 60))
        rendered = true
      }

      app = library.wlLive2d({
        selector: options.selector,
        fixed: false,
        drag: false,
        sayHello: false,
        hitFrame: false,
        menus: [],
        tips: {
          talk: false,
          drag: false,
          motionMessage: false,
          message: [],
          talkApis: [],
        },
        transitionTime: 250,
        // The model only loads after a user explicitly enables Live2D. Once
        // enabled, preload the small motion files so the first tap is a real
        // interaction instead of a delayed network request.
        models: [{
          path: options.modelUrl,
          width: options.canvasWidth,
          height: options.canvasHeight,
          position: { x: 0, y: 0 },
          motionPreload: 'ALL',
        }],
      })

      const session: Live2DStageSession = {
        kind: 'browser',
        capability: BROWSER_CAPABILITY,
        onModelLoaded(callback) {
          app.onModelLoaded((model) => {
            if (!model) return // wl-live2d also emits null after a load error.
            if (destroyed) { model.visible = false; return }
            rawModel = model
            if (typeof model.update === 'function' && app.app?.ticker?.add) {
              model.autoUpdate = false
              app.app.ticker.add(advanceModel, undefined, 50)
            }
            modelHandle = wrapModel(model)
            screenSize = {
              width: Number(app.app?.screen?.width) || options.canvasWidth,
              height: Number(app.app?.screen?.height) || options.canvasHeight,
            }
            callback(modelHandle)
          })
        },
        onModelError(callback) {
          app.onModelError(error => { if (!destroyed) callback(error) })
        },
        setPaused(value, renderFirstFrame = false) {
          if (destroyed) return
          paused = value
          const ticker = app.app?.ticker
          if (!ticker) return
          if (paused) {
            if (ticker.started) ticker.stop()
            // Only explicit reduced-motion presentation may draw a static frame.
            // Drawing during teardown starts an async idle motion against a model
            // that wl-live2d is about to destroy (its queueManager is then gone).
            if (renderFirstFrame && !rendered && rawModel?.visible) {
              rawModel.update?.(0)
              app.app?.render?.()
              rendered = true
            }
            return
          }
          if (!ticker.started) ticker.start()
        },
        setMaxFps(fps) {
          if (destroyed) return
          const ticker = app.app?.ticker
          if (ticker) ticker.maxFPS = fps
        },
        getScreenSize() { return { ...screenSize } },
        getCanvasSize() {
          if (typeof document === 'undefined') return { ...screenSize }
          const host = document.querySelector<HTMLElement>(options.selector)
          const cvs = host?.querySelector('canvas')
          if (!cvs) return { ...screenSize }
          return {
            width: parseFloat(cvs.style.width) || cvs.width || screenSize.width,
            height: parseFloat(cvs.style.height) || cvs.height || screenSize.height,
          }
        },
        setStageScale(scale) {
          if (destroyed) return
          if (typeof document === 'undefined') return
          const host = document.querySelector<HTMLElement>(options.selector)
          const wrapper = host?.firstElementChild as HTMLElement | null
          if (!wrapper) return
          wrapper.style.transform = `translateX(-50%) scale(${scale > 0 ? scale : 1})`
        },
        canvasElement() {
          if (typeof document === 'undefined') return null
          const host = document.querySelector<HTMLElement>(options.selector)
          return host?.querySelector('canvas') ?? null
        },
        destroy() {
          if (destroyed) return
          destroyed = true
          const ticker = app.app?.ticker
          if (ticker?.started) ticker.stop()
          ticker?.remove?.(advanceModel)
          if (rawModel) rawModel.autoUpdate = false
          rawModel = null
          if (modelHandle) modelHandle.visible = false
          modelHandle = null
          if (typeof app.destroy === 'function') { try { app.destroy() } catch { /* 与原 destroyRuntime 一致 */ } }
        },
      }
      return session
    },
  }
}

async function loadLibrary(): Promise<WlLive2DLibrary> {
  const live2DWindow = window as Window & typeof globalThis & { 'wl-live2d'?: WlLive2DLibrary }
  const existing = readLibrary(live2DWindow['wl-live2d'])
  if (existing) return existing
  try {
    const library = readLibrary(await import('wl-live2d'))
    if (library) {
      live2DWindow['wl-live2d'] = library
      return library
    }
    throw new Error('wl-live2d 导出中没有 wlLive2d')
  } catch (e) {
    throw new Error('wl-live2d 运行库导入失败：' + errorMessage(e))
  }
}
