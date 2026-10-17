/**
 * 陪伴行为状态机（纯 TS，无 DOM）。
 *
 * 职责：用户无操作提醒、安静时段、提醒冷却与常驻气泡队列（勿扰优先级）。
 * 只负责确定性策略：不产生不可预测的情绪累积，不调用 LLM，不触达 TTS。
 * 台词与 UI 展示由调用方（CompanionView）负责。
 */

export interface CompanionBehaviorConfig {
  /** 主动行为总开关（无操作提醒、常驻气泡、事件播报） */
  enabled: boolean
  /** 勿扰：暂停一切主动气泡出队；队列保留，关闭勿扰后继续 */
  dnd: boolean
  /** 无操作多少分钟后触发提醒；0 表示关闭提醒 */
  idleMinutes: number
  /** 一次提醒后多久内不再提醒 */
  cooldownMinutes: number
  /** 安静时段开始（0-23 小时，本地时间）；quietEnd 之前都安静 */
  quietStartHour: number
  /** 安静时段结束（0-23 小时，本地时间） */
  quietEndHour: number
  /** 气泡队列容量 */
  queueLimit: number
  /** 同类事件（出图/训练/服务）最短播报间隔 */
  eventCooldownMinutes: number
}

export type CompanionEventKind =
  | 'sd-done'
  | 'service-back'
  | 'service-down'

export interface CompanionReminder {
  /** 提醒标识（入队时分配） */
  id: string
  /** 入队时间（epoch ms） */
  at: number
  /** 提醒种类，UI 可据此选择样式 */
  kind: 'idle' | 'return' | 'event'
  /** 事件提醒的具体事件（kind === 'event' 时有效），UI 可据此跳转 */
  eventKind?: CompanionEventKind
  /** 台词内容（由调用方提供，按当前角色选择） */
  line: string
}

export interface CompanionBehaviorHandle {
  /** 记录一次用户活动（输入、点击、交互等），重置 idle 计时 */
  noteActivity(now?: number): void
  /**
   * 推进状态机。返回本次 tick 新入队的提醒（无则 null）。
   * 只有 enabled 且不在安静时段、冷却已过、idle 超时才产出 idle 提醒；
   * return 提醒由调用方显式 noteReturn() 触发，不受 idle/冷却约束，
   * 但受安静时段与 dnd 约束。
   */
  tick(now?: number): CompanionReminder | null
  /** 角色回到前台/窗口重新可见时入队一条"回来"气泡（受安静时段与 dnd 约束） */
  noteReturn(line: string, now?: number): CompanionReminder | null
  /**
   * 入队一条事件播报（出图/训练/服务事件，受安静时段与 dnd 约束）。
   * 同类事件按 eventCooldownMinutes 节流，避免轮询重复触发；
   * 事件不消耗 idle 提醒冷却。
   */
  noteEvent(eventKind: CompanionEventKind, line: string, now?: number): CompanionReminder | null
  /** 当前是否处于安静时段 */
  inQuietHours(now?: number): boolean
  /** 勿扰状态（引用会随配置变更） */
  isDnd(): boolean
  /** 待展示队列（FIFO） */
  pending(): readonly CompanionReminder[]
  /** 取出并返回队首提醒（勿扰时返回 null，队列保留） */
  dequeue(now?: number): CompanionReminder | null
  /** 移除指定提醒（用户手动关闭） */
  dismiss(id: string): void
  /** 距上次提醒剩余冷却毫秒数（负数表示已过冷却） */
  cooldownRemainingMs(now?: number): number
  /** 清空队列 */
  clear(): void
  /** 替换配置（保留队列与 lastActivity） */
  setConfig(patch: Partial<CompanionBehaviorConfig>): void
  config(): Readonly<CompanionBehaviorConfig>
}

const DEFAULT_COMPANION_CONFIG: CompanionBehaviorConfig = {
  enabled: true,
  dnd: false,
  idleMinutes: 30,
  cooldownMinutes: 20,
  quietStartHour: 23,
  quietEndHour: 8,
  queueLimit: 3,
  eventCooldownMinutes: 10,
}

export function normalizeCompanionConfig(raw: unknown): CompanionBehaviorConfig {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    enabled: value.enabled !== false,
    dnd: value.dnd === true,
    idleMinutes: clampInt(value.idleMinutes, 0, 24 * 60, DEFAULT_COMPANION_CONFIG.idleMinutes),
    cooldownMinutes: clampInt(value.cooldownMinutes, 0, 24 * 60, DEFAULT_COMPANION_CONFIG.cooldownMinutes),
    quietStartHour: clampInt(value.quietStartHour, 0, 23, DEFAULT_COMPANION_CONFIG.quietStartHour),
    quietEndHour: clampInt(value.quietEndHour, 0, 23, DEFAULT_COMPANION_CONFIG.quietEndHour),
    queueLimit: clampInt(value.queueLimit, 1, 20, DEFAULT_COMPANION_CONFIG.queueLimit),
    eventCooldownMinutes: clampInt(value.eventCooldownMinutes, 0, 24 * 60, DEFAULT_COMPANION_CONFIG.eventCooldownMinutes),
  }
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (value == null || value === '' || typeof value === 'boolean') return fallback
  const number = Number(value)
  if (!Number.isInteger(number)) return fallback
  return Math.max(min, Math.min(max, number))
}

function hourOf(date: Date): number {
  return date.getHours()
}

/** 安静时段可能跨天（23:00-08:00），也可能在同一天内（08:00-23:00）。 */
function isInQuietHours(
  now: number,
  quietStartHour: number,
  quietEndHour: number,
): boolean {
  const hour = hourOf(new Date(now))
  if (quietStartHour === quietEndHour) return false
  if (quietStartHour < quietEndHour) {
    return hour >= quietStartHour && hour < quietEndHour
  }
  return hour >= quietStartHour || hour < quietEndHour
}

let nextReminderId = 0

function createReminderId(): string {
  nextReminderId += 1
  return `r-${Date.now().toString(36)}-${nextReminderId}`
}

export function createCompanionBehavior(
  rawConfig: unknown = DEFAULT_COMPANION_CONFIG,
): CompanionBehaviorHandle {
  const config = normalizeCompanionConfig(rawConfig)
  const queue: CompanionReminder[] = []
  const lastEventAt = new Map<CompanionEventKind, number>()
  let lastActivity = Date.now()
  let lastReminderAt = Number.NEGATIVE_INFINITY

  function noteActivity(now = Date.now()): void {
    lastActivity = now
  }

  function canProduce(now: number): boolean {
    return config.enabled && !config.dnd && !isInQuietHours(now, config.quietStartHour, config.quietEndHour)
  }

  function enqueue(kind: 'idle' | 'return' | 'event', line: string, now: number, eventKind?: CompanionEventKind): CompanionReminder {
    const reminder: CompanionReminder = { id: createReminderId(), at: now, kind, line, ...(eventKind ? { eventKind } : {}) }
    queue.push(reminder)
    if (queue.length > config.queueLimit) queue.splice(0, queue.length - config.queueLimit)
    return reminder
  }

  function tick(now = Date.now()): CompanionReminder | null {
    if (!canProduce(now)) return null
    if (config.idleMinutes <= 0) return null
    const idleMs = (now - lastActivity) / 60000
    if (idleMs < config.idleMinutes) return null
    if (now - lastReminderAt < config.cooldownMinutes * 60000) return null
    lastReminderAt = now
    return enqueue('idle', '', now)
  }

  function noteReturn(line: string, now = Date.now()): CompanionReminder | null {
    if (!canProduce(now)) return null
    lastReminderAt = now
    return enqueue('return', line, now)
  }

  function noteEvent(eventKind: CompanionEventKind, line: string, now = Date.now()): CompanionReminder | null {
    if (!canProduce(now)) return null
    const lastAt = lastEventAt.get(eventKind) ?? Number.NEGATIVE_INFINITY
    if (now - lastAt < config.eventCooldownMinutes * 60000) return null
    lastEventAt.set(eventKind, now)
    return enqueue('event', line, now, eventKind)
  }

  function dequeue(now = Date.now()): CompanionReminder | null {
    if (!canProduce(now)) return null
    return queue.shift() ?? null
  }

  function dismiss(id: string): void {
    const index = queue.findIndex(reminder => reminder.id === id)
    if (index >= 0) queue.splice(index, 1)
  }

  return {
    noteActivity,
    tick,
    noteReturn,
    noteEvent,
    inQuietHours: (now = Date.now()) => isInQuietHours(now, config.quietStartHour, config.quietEndHour),
    isDnd: () => config.dnd,
    pending: () => queue.slice(),
    dequeue,
    dismiss,
    cooldownRemainingMs: (now = Date.now()) => lastReminderAt + config.cooldownMinutes * 60000 - now,
    clear: () => { queue.length = 0 },
    setConfig: patch => {
      Object.assign(config, normalizeCompanionConfig({ ...config, ...patch }))
      if (queue.length > config.queueLimit) queue.splice(0, queue.length - config.queueLimit)
    },
    config: () => ({ ...config }),
  }
}
