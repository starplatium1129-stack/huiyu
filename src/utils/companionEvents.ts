/**
 * 陪伴事件检测器（纯 TS，无 DOM）。
 *
 * 职责：把已确认任务结果与服务状态快照的差异
 * 翻译成 Companion 可播报的事件。只做确定性对比，不发起任何请求、
 * 不调用 LLM；轮询与入队由调用方负责。
 */

export interface CompanionTaskSnapshot {
  id: string
  createdAt: number
  ready: boolean
}
export type CompanionServicesSnapshot = Partial<Record<'comfy' | 'tts' | 'ollama' | 'llama', boolean>>

export interface CompanionEventSnapshot {
  observedAt: number
  /** null means the read failed, so retain the previous successful baseline. */
  tasks: readonly CompanionTaskSnapshot[] | null
  services: CompanionServicesSnapshot | null
  /** Native status checks entry files only, never a successful model load. */
  nativeFiles?: boolean | null
}

export type CompanionDetectedEvent = 'image-ready' | 'service-back' | 'service-down' | 'image-files-ready' | 'image-files-missing'

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
  let tasks: Map<string, CompanionTaskSnapshot> | null = null
  let services: CompanionServicesSnapshot = {}
  let since = 0, nativeFiles: boolean | null = null
  const notified = new Set<string>()

  function ingest(snapshot: CompanionEventSnapshot): CompanionDetectedEvent[] {
    const events: CompanionDetectedEvent[] = []
    if (snapshot.tasks !== null) {
      if (tasks === null) since = snapshot.observedAt
      for (const task of snapshot.tasks) {
        const prior = tasks?.get(task.id)
        if (task.ready && !notified.has(task.id)) {
          // Historical reads can reintroduce old IDs; only transitions or tasks
          // created after the first snapshot can announce a new result.
          if (tasks !== null && (prior ? !prior.ready : task.createdAt > since)) events.push('image-ready')
          notified.add(task.id)
        }
      }
      tasks = new Map(snapshot.tasks.map(task => [task.id, { ...task }]))
      while (notified.size > 256) notified.delete(notified.values().next().value!)
    }
    if (snapshot.services !== null) {
      for (const key of Object.keys(snapshot.services) as Array<keyof CompanionServicesSnapshot>) {
        const was = services[key], now = snapshot.services[key]
        if (was === false && now === true) events.push('service-back')
        else if (was === true && now === false) events.push('service-down')
      }
      services = { ...snapshot.services }
    }
    if (snapshot.nativeFiles !== undefined) {
      if (nativeFiles !== null && snapshot.nativeFiles !== null && nativeFiles !== snapshot.nativeFiles)
        events.push(snapshot.nativeFiles ? 'image-files-ready' : 'image-files-missing')
      nativeFiles = snapshot.nativeFiles
    }
    return [...new Set(events)]
  }

  function reset(): void {
    tasks = null; services = {}; since = 0; nativeFiles = null; notified.clear()
  }

  return { ingest, reset }
}

/** 事件 → 跳转的 Atelier 路由（供 UI 点击气泡时使用）。 */
export const EVENT_ROUTE: Record<CompanionDetectedEvent, string> = {
  'image-ready': '/gallery?tasks=inbox',
  'service-back': '/control',
  'service-down': '/control',
  'image-files-ready': '/control',
  'image-files-missing': '/control',
}

/** 事件 → 系统通知标题（供 desktopBridge.notify 使用）。 */
export const EVENT_NOTIFY_TITLE: Record<CompanionDetectedEvent, string> = {
  'image-ready': '图片生成完成',
  'service-back': '服务恢复',
  'service-down': '服务掉线',
  'image-files-ready': '原生绘图入口文件已准备',
  'image-files-missing': '原生绘图入口文件待检查',
}
