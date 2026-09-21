/**
 * Live2D 渲染后端抽象 —— 双后端契约（路径 B）。
 *
 * 现状：唯一后端是浏览器端 wl-live2d（Pixi + Cubism Web）。
 * 目标：桌面端新增"原生角色图层窗口"后端（Rust + wgpu 直接向 WS_EX_LAYERED
 * overlay HWND 呈现，Cubism Native 官方运行时执行 motion/physics/pose/
 * expression/hit-test），浏览器端继续使用 wl-live2d 不动。
 *
 * 本文件只定义契约：后端能力、会话生命周期、统一模型句柄。
 * 具体实现见 browserBackend.ts / nativeBackend.ts，工厂见 createBackend.ts。
 */

export type Live2DBackendKind = 'browser' | 'native'

/** 后端能力位。useLive2D 依据它决定哪些"浏览器 hack"可以跳过。 */
export interface Live2DCapability {
  /** 前端能否逐帧覆写模型参数（浏览器 true；原生 false，参数由作者工程执行） */
  readonly parameterOverride: boolean
  /** 口型通道：true=前端写参数，false=意图经桥（mouth level 送 Rust 由 lip-sync 执行） */
  readonly lipSyncChannel: 'params' | 'bridge'
  /** 情绪通道：true=前端写参数，false=意图经桥（emotion 名称/强度送 Rust） */
  readonly emotionChannel: 'params' | 'bridge'
  /** 眨眼：true=前端 blinkScheduler 覆盖，false=作者工程原生眨眼（Rust 侧） */
  readonly blinkOverride: boolean
  /** 点击命中：true=DOM 分区 + wl hitTest 兜底，false=Cubism 原生 HitArea（Rust 侧） */
  readonly hitTestNative: boolean
  /** 登场/告别动作是否由后端（Rust）接管 */
  readonly entranceNative: boolean
}

export const BROWSER_CAPABILITY: Live2DCapability = {
  parameterOverride: true,
  lipSyncChannel: 'params',
  emotionChannel: 'params',
  blinkOverride: true,
  hitTestNative: false,
  entranceNative: false,
}

export const NATIVE_CAPABILITY: Live2DCapability = {
  parameterOverride: false,
  lipSyncChannel: 'bridge',
  emotionChannel: 'bridge',
  blinkOverride: false,
  hitTestNative: true,
  entranceNative: true,
}

/** Profile subset shared with the native renderer; contains no UI or user data. */
export interface Live2DRuntimeAdapterConfig {
  profileId: string
  mouth?: { id: string; scale: number; range?: [number, number] }
  blink: readonly string[]
  focus: readonly string[]
  emotionParams: Readonly<Record<string, Record<string, number>>>
  overlaySettle?: { settleMs: number; resetDefaults: Record<string, number> }
  entranceGroup?: string
  leaveGroup?: string
}

/** 统一模型句柄。浏览器实现包装 wl-live2d model，原生实现经桥委托 Rust。 */
export interface Live2DModelHandle {
  /** Runtime enumeration is separate from model JSON declarations. */
  enumerateParameters?(): import('./modelParameters').Live2DParameterEnumeration
  stopAnimation?(): void
  /** 与 wl-live2d 语义一致：模型网格可见性（原生端映射为 overlay 可见性） */
  visible: boolean
  /** 播放动作组；priority 沿用 wl-live2d 数值（3=FORCE），原生端映射到 Cubism MotionPriority */
  motion(group: string, index?: number, priority?: number): Promise<boolean> | boolean
  /** 应用 Expression（宁宁校服/常服等衣装；原生端经桥执行） */
  expression(name: string): Promise<boolean> | boolean
  /** Cubism HitArea 命中（作者在模型里画的区域 id；浏览器端作兜底） */
  hitTest(x: number, y: number): string[]
  /** 目光聚焦（作者眼/头参数跟随） */
  focus(x: number, y: number): void
  /** 逐帧写参数（仅在 capability.parameterOverride 时调用） */
  setParameterValueById(id: string, value: number, weight: number): void
  /** 读取参数当前值（可选能力；夏目叠层回落需捕获动作结束时的现值） */
  getParameterValueById?(id: string): number | undefined
  /** 订阅每帧参数更新前回调（浏览器：internalModel.beforeModelUpdate） */
  onBeforeModelUpdate(callback: () => void): void
  /** 一次应用 fit 结果：scale 与模型位置 */
  applyFit(scale: number, x: number, y: number): void
  /** 模型自然尺寸（未缩放，画布逻辑单位） */
  getNaturalSize(): { width: number; height: number }
  /** 动作组是否存在（浏览器探测 motionManager.definitions；原生端由 Rust 管理，返回 false） */
  hasMotionGroup?(group: string): boolean
  /** 当前正在播放的动作组；null 表示已结束，undefined 表示运行库不支持查询。 */
  getActiveMotionGroup?(): string | null | undefined
}

export interface Live2DConnectOptions {
  /** 取消尚未完成的连接，防止超时或卸载后创建迟到的渲染会话。 */
  signal?: AbortSignal
  /** 浏览器后端：wl-live2d 宿主选择器；原生后端忽略 */
  selector: string
  /** 模型 model3.json 路径（原生端由 Rust 从本地资产读取，不需要下载到 WebView2） */
  modelUrl: string
  /** 画布逻辑尺寸（来自 /api/live2d-status 的 canvas 字段） */
  canvasWidth: number
  canvasHeight: number
  /** 角色 id（原生端决定动作组/情绪映射） */
  character: string
  /** Validated model-specific bindings compiled from the selected avatar Profile. */
  adapter?: Live2DRuntimeAdapterConfig
  /** Optional texture downsampling divisor; source atlases remain unchanged. */
  textureScale?: number
}

/** 后端会话：连接后管理一个模型实例的生命周期与舞台交互。 */
export interface Live2DStageSession {
  readonly kind: Live2DBackendKind
  readonly capability: Live2DCapability

  onModelLoaded(callback: (model: Live2DModelHandle) => void): void
  onModelError(callback: (error: Error) => void): void

  /** 暂停/恢复渲染循环（浏览器：Pixi ticker；原生：Rust 渲染循环） */
  setPaused(paused: boolean, renderFirstFrame?: boolean): void
  /** 帧率上限（浏览器：ticker.maxFPS；原生：Rust 侧 fps clamp） */
  setMaxFps(fps: number): void

  /** 舞台画布逻辑尺寸（focus 归位与布局用） */
  getScreenSize(): { width: number; height: number }
  /** 实际 canvas 尺寸（浏览器：DOM 测量；原生：overlay 逻辑尺寸） */
  getCanvasSize(): { width: number; height: number }
  /** 浏览器：缩放 wrapper（translateX(-50%) scale）；原生：无（尺寸由 overlay 帧决定） */
  setStageScale(scale: number): void
  /** 原生专属：下发 Companion-local 物理像素矩形，Rust 用实时 HWND 位置 SetWindowPos */
  updateOverlay?(
    rect: { x: number; y: number; width: number; height: number },
    visible: boolean,
    framing?: { zoom: number; x: number; y: number },
  ): void
  /** 浏览器：取 canvas 元素（webglcontextlost/restored 绑定）；原生：null */
  canvasElement(): HTMLElement | null
  resizeCanvas?(width: number, height: number): void

  /** 原生专属：Rust 回传的 Cubism 原生 HitArea 命中（kind === 'native' 时存在） */
  onNativeHitTest?(callback: (areas: string[]) => void): () => void
  /** 原生专属：动作被拒绝（含同一互动播放中重复点击的 busy 拒绝） */
  onMotionFailed?(callback: (info: { group: string; index?: number; reason: string }) => void): () => void
  /** 原生专属：目光凝视意图（归一化 -1..1，Rust 映射到作者眼/头参数） */
  sendGaze?(x: number, y: number): void
  /** 原生专属：口型意图（capability.lipSyncChannel === 'bridge' 时由 useLive2D 调用） */
  sendMouthLevel?(level: number): void
  /** 原生专属：情绪意图（capability.emotionChannel === 'bridge' 时由 useLive2D 调用） */
  sendEmotion?(name: string, intensity: number): void

  destroy(): void
}

export interface Live2DStageBackend {
  readonly kind: Live2DBackendKind
  readonly capability: Live2DCapability
  /** 建立会话。失败必须 reject（useLive2D 据此 fallback 到浏览器后端）。 */
  connect(options: Live2DConnectOptions): Promise<Live2DStageSession>
}

/** 原生后端未就绪（桥缺失）时抛出的错误名，工厂据此触发 fallback。 */
export const NATIVE_BACKEND_UNAVAILABLE = 'NATIVE_BACKEND_UNAVAILABLE'
