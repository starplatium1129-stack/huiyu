/**
 * 陪伴事件检测器（纯 TS，无 DOM）。
 *
 * 职责：把网关状态轮询快照（服务在线、训练任务、出图入库计数）的差异
 * 翻译成 Companion 可播报的事件。只做确定性对比，不发起任何请求、
 * 不调用 LLM；轮询与入队由调用方负责。
 */

import type { CompanionEventKind } from './companionBehavior'

export interface CompanionServicesSnapshot {
  sdOnline: boolean
  ttsOnline: boolean
  ollamaOnline: boolean
}

export interface CompanionEventSnapshot {
  /** 作品库图片总数（IndexedDB 计数），增加视为出图完成 */
  imageCount: number | null
  services: CompanionServicesSnapshot
}

export type CompanionDetectedEvent = 'sd-done' | 'service-back' | 'service-down'

export interface CompanionEventDetector {
  /**
   * 喂入最新快照，返回与上一份快照相比新检测到的事件。
   * 首次调用只建立基线，不产生事件。
   */
  ingest(snapshot: CompanionEventSnapshot): CompanionDetectedEvent[]
  /** 重置基线（窗口重载后避免重复播报） */
  reset(): void
}

export function createCompanionEventDetector(): CompanionEventDetector {
  let baseline: CompanionEventSnapshot | null = null

  function ingest(snapshot: CompanionEventSnapshot): CompanionDetectedEvent[] {
    const events: CompanionDetectedEvent[] = []
    if (baseline) {
      if (snapshot.imageCount != null && baseline.imageCount != null && snapshot.imageCount > baseline.imageCount) events.push('sd-done')

      for (const key of ['sdOnline', 'ttsOnline', 'ollamaOnline'] as const) {
        const was = baseline.services[key]
        const now = snapshot.services[key]
        if (!was && now) events.push('service-back')
        else if (was && !now) events.push('service-down')
      }
    }
    baseline = { ...snapshot, imageCount: snapshot.imageCount ?? baseline?.imageCount ?? null, services: { ...snapshot.services } }
    return [...new Set(events)]
  }

  function reset(): void {
    baseline = null
  }

  return { ingest, reset }
}

/** 事件 → 跳转的 Atelier 路由（供 UI 点击气泡时使用）。 */
export const EVENT_ROUTE: Record<CompanionDetectedEvent, string> = {
  'sd-done': '/gallery',
  'service-back': '/control',
  'service-down': '/control',
}

/** 事件 → 系统通知标题（供 desktopBridge.notify 使用）。 */
export const EVENT_NOTIFY_TITLE: Record<CompanionDetectedEvent, string> = {
  'sd-done': '新图入库',
  'service-back': '服务恢复',
  'service-down': '服务掉线',
}
