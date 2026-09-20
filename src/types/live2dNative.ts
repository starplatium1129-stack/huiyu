/**
 * Live2D 原生 overlay 桥契约（路径 B）。
 *
 * Rust 壳（desktop-tauri）创建一个透明的 WS_EX_LAYERED overlay 窗口，
 * 用 wgpu + Cubism Native 直接向该 HWND 呈现 Live2D 模型；浏览器端继续
 * 用 wl-live2d 不动。本文件定义前端与 Rust 之间的 IPC 契约：
 *
 * - 通道命名：Tauri command 前缀 `aics_live2d_*`；Rust → 前端事件统一经
 *   `aics:live2d:*`。浏览器后端（wl-live2d）不涉及本契约。
 * - 坐标系：setFrame 的 overlay 矩形为 Companion-local 物理像素；Rust 使用
 *   Companion HWND 的实时屏幕位置换算后 SetWindowPos，避免拖动事件滞后。
 * - 情绪/口型只传"意图"（名称与强度），参数级写入由 Cubism Native 按作者
 *   工程执行；blinkScheduler / MOUTH_PARAMS / emotionRuntime 参数 hack 在
 *   原生后端全部退役（浏览器端保留）。
 */

/** overlay 矩形（Companion-local 物理像素） */
import type { Live2DRuntimeAdapterConfig } from '../live2d/types.ts'

export interface Live2DOverlayRect {
  x: number
  y: number
  width: number
  height: number
}

export type Live2DMotionPriority = 'idle' | 'normal' | 'force'

/** 原生 hit test 命中区（作者在模型里画的 HitArea id） */
export type Live2DHitArea = string

export interface Live2DNativeCommands {
  /** 创建/切换模型。modelPath 只接受 Rust 侧白名单资产，不接收任意路径。 */
  setCharacter(modelPath: string, options?: {
    character: string
    textureScale?: number
    adapter?: Live2DRuntimeAdapterConfig
  }): Promise<{ ok: boolean; error?: string }>
  /** 移动 overlay 并设置可见性。visible=false 时 Rust 可隐藏窗口并暂停渲染。 */
  setFrame(frame: {
    rect: Live2DOverlayRect
    visible: boolean
    opacity?: number
    framing?: { zoom: number; x: number; y: number }
  }): Promise<void>
  /** 设置原生渲染循环的目标帧率。 */
  setMaxFps(fps: number): Promise<void>
  /** 播放动作组（Rust 用 Cubism MotionPriority 语义，FORCE 打断 idle） */
  playMotion(group: string, index?: number, priority?: Live2DMotionPriority): Promise<{ ok: boolean; error?: string }>
  /** 应用 Expression（宁宁衣装；夏目无 Expressions 由 Rust 拒绝） */
  setExpression(name: string): Promise<{ ok: boolean; error?: string }>
  /** 口型意图 0..1（Rust 映射到作者 lip-sync 参数） */
  setMouthLevel(level: number): Promise<void>
  /** 情绪意图（name 见 ChatEmotion；intensity 0..1） */
  setEmotion(name: string, intensity: number): Promise<void>
  /** 目光凝视意图（归一化 -1..1，基于舞台中心） */
  setGaze(x: number, y: number): Promise<void>
  /** 归一化坐标（0..1，overlay 相对）上的 Cubism 原生 HitArea 查询 */
  hitTest(x: number, y: number): Promise<{ areas: Live2DHitArea[] }>
  /** 释放模型并销毁 overlay */
  destroy(): Promise<void>
}

/** Rust → 前端事件。订阅函数返回 id，off 注销。 */
export interface Live2DNativeEvents {
  /** 模型加载完成（此时可发 setFrame 显示） */
  onReady(listener: () => void): number
  /** 动作已启动（前端据此显示互动提示/高亮，与浏览器端 markInteractionStarted 对齐） */
  onMotionStarted(listener: (info: { group: string; index?: number }) => void): number
  /** 动作被拒绝（前端显示"动作进行中/重试"） */
  onMotionFailed(listener: (info: { group: string; index?: number; reason: string }) => void): number
  /** overlay 捕获到点击并经 Cubism HitArea 命中（作者分区优先于 DOM 分区） */
  onHitTest(listener: (areas: Live2DHitArea[]) => void): number
  /** 入场动作结束（前端恢复常规状态提示） */
  onEntranceFinished(listener: () => void): number
  /** 渲染线程停止（异常退出/通道断开/窗口销毁；前端显示错误并允许重试） */
  onStopped(listener: (info: { reason: string }) => void): number
  off(subscriptionId: number): void
}

/**
 * Rust 壳注入前端的全局桥。注入方式：initialization script 在页面顶层创建
 * `window.aicsLive2dNative`（与 companionDesktop 同机制）。浏览器后端/纯
 * Web 环境不存在该对象。
 */
export interface Live2DNativeBridge extends Live2DNativeCommands, Live2DNativeEvents {
  readonly isNativeLive2D: true
  readonly supportsTextureQuality?: boolean
  readonly supportsFraming?: boolean
}

declare global {
  interface Window {
    aicsLive2dNative?: Live2DNativeBridge
  }
}

export {}
