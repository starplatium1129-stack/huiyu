import { profileLocalStorage as localStorage } from '../platform/web/profileStorage.ts'
import { computed, onMounted, onUnmounted, ref, watch, type Ref } from 'vue'
import { usePolling } from './usePolling'
import type { CompanionDesktopBridge } from '@/types/desktop'
import { controlApi } from '@/api/controlApi'
import { pickCompanionLine } from '@/config/characters'
import { pickEnvironmentGreeting } from '@/utils/environmentContext'
import { createCompanionBehavior, normalizeCompanionConfig, type CompanionReminder } from '@/utils/companionBehavior'
import {
  createCompanionEventDetector,
  EVENT_NOTIFY_TITLE,
  EVENT_ROUTE,
  type CompanionDetectedEvent,
} from '@/utils/companionEvents'
import { COMPANION_BEHAVIOR_KEY } from '@/utils/storageKeys'

export interface CompanionBehaviorRuntimeDeps {
  activeChar: Ref<string>
  desktopBridge?: CompanionDesktopBridge
  /** 桌面悬浮窗当前是否可见（不可见时不问候、不轮询下行）。 */
  desktopWindowVisible: () => boolean
  /** 语音自动收听重算（勿扰/安静时段/时间片变化影响 gating）。 */
  reconcileAutoListen: () => void
}

/**
 * 陪伴页「角色行为运行时」（2026-08-22 自 CompanionView 下沉）。
 *
 * 两只 30s 心跳：behavior.tick 驱动待办提醒与时间片环境问候
 * （同一时间片只问候一次，周日/周末视为不同片）；pollCompanionEvents
 * 聚合 SD/TTS/Ollama/训练任务/图片计数喂给事件检测器，产出事件提醒
 * 并同步任务栏进度环。勿扰/安静时段 gating、提醒入队（noteReturn 族）
 * 与事件路由跳转同归此处；两个定时器与轮询 AbortController 的
 * 生命周期由本 composable 自持。
 */
export function useCompanionBehaviorRuntime(deps: CompanionBehaviorRuntimeDeps) {
  const { activeChar, desktopBridge, desktopWindowVisible, reconcileAutoListen } = deps

  const config = ref(readBehaviorConfig())
  const behavior = createCompanionBehavior(config.value)
  const behaviorEnabled = computed(() => config.value.enabled)
  const dnd = ref(behavior.config().dnd)
  const pendingReminders = ref<CompanionReminder[]>([])
  const inQuietHours = ref(behavior.inQuietHours())
  const quietHoursText = computed(() => {
    const { quietStartHour, quietEndHour } = config.value
    return `安静时段 ${quietStartHour}:00 – ${quietEndHour}:00 不主动问候`
  })

  const eventDetector = createCompanionEventDetector()
  // 工程审计 P1-9（2/2）：两只 30s 心跳迁到 usePolling 底座，语义不变。
  // immediate=false 保持「首 tick 在 +30s」原时序（onMounted 里另有显式首跑）；
  // pollCompanionEvents 自带 eventPolling 守卫，与 usePolling 的 in-flight 去重叠加无害；
  // stop 由 onUnmounted 显式调用，setup 期 onScopeDispose 兜底 component 之外的手动实例。
  const behaviorPoll = usePolling({ intervalMs: 30_000, immediate: false, tick: runBehaviorTick })
  const eventPoll = usePolling({ intervalMs: 30_000, immediate: false, tick: pollCompanionEvents })
  let reminderLineOffset = 0
  let eventLineOffset = 0
  let eventPolling = false
  let eventPollController: AbortController | null = null
  let lastActivityAt = Date.now()
  let greetedSlotKey = ''
  let alive = true

  function readBehaviorConfig() {
    try {
      return normalizeCompanionConfig(JSON.parse(localStorage.getItem(COMPANION_BEHAVIOR_KEY) || 'null'))
    } catch {
      return normalizeCompanionConfig(null)
    }
  }

  function persistBehaviorConfig() {
    try { localStorage.setItem(COMPANION_BEHAVIOR_KEY, JSON.stringify(behavior.config())) } catch { /* 隐私模式忽略 */ }
  }

  function syncReminders() {
    inQuietHours.value = behavior.inQuietHours()
    for (const reminder of behavior.pending()) if (Date.now() - reminder.at > 30 * 60_000) behavior.dismiss(reminder.id)
    pendingReminders.value = behaviorEnabled.value && !dnd.value && !inQuietHours.value ? behavior.pending().slice() : []
  }

  function noteActivity() {
    behavior.noteActivity()
    lastActivityAt = Date.now()
  }

  /** 离开时长判定用（窗口重新可见时决定是否给「回来」问候）。 */
  function getLastActivityAt(): number {
    return lastActivityAt
  }

  /** 「回来」问候的离开阈值（分钟，0 = 关闭）。 */
  function getIdleMinutes(): number {
    return behavior.config().idleMinutes
  }

  /** 带台词轮转入队：先轮转 offset 再取词（返回/导入问候路径）。 */
  function noteReturn(pickLine: (offset: number) => string) {
    reminderLineOffset += 1
    const reminder = behavior.noteReturn(pickLine(reminderLineOffset))
    if (reminder) syncReminders()
  }

  /** 不轮转台词序号的入队（剪贴板固定话术路径）。 */
  function noteReturnPlain(line: string) {
    const reminder = behavior.noteReturn(line)
    if (reminder) syncReminders()
  }

  function toggleDnd() {
    const next = !behavior.config().dnd
    behavior.setConfig({ dnd: next })
    config.value = behavior.config()
    dnd.value = next
    persistBehaviorConfig()
    syncReminders()
    reconcileAutoListen()
  }

  function dismissReminder(id: string) {
    behavior.dismiss(id)
    syncReminders()
  }

  /** 时间片问候：同一时间片只入队一次；周日/周末视为不同片 */
  function currentGreetedSlotKey(): string {
    const now = new Date()
    const greeting = pickEnvironmentGreeting(activeChar.value, now)
    return `${activeChar.value}:${now.toDateString()}:${greeting.slot}:${greeting.weekend ? 'w' : 'd'}`
  }

  function maybeGreetByTime(force = false) {
    if (!behaviorEnabled.value || !desktopWindowVisible()) return
    const key = currentGreetedSlotKey()
    if (!force && key === greetedSlotKey) return
    const greeting = pickEnvironmentGreeting(activeChar.value, new Date(), reminderLineOffset)
    reminderLineOffset += 1
    const reminder = behavior.noteReturn(greeting.line)
    if (reminder) { greetedSlotKey = key; syncReminders() }
  }

  function runBehaviorTick() {
    syncReminders()
    const reminder = desktopWindowVisible() ? behavior.tick() : null
    if (reminder) {
      reminderLineOffset += 1
      reminder.line = pickCompanionLine(activeChar.value, 'idle', reminderLineOffset)
      syncReminders()
    }
    // 跨时间片（午→下午、工作日→周末）时给一条环境问候
    if (alive && desktopWindowVisible()) maybeGreetByTime()
    reconcileAutoListen()
  }

  async function pollCompanionEvents() {
    if (eventPolling || !alive) return
    if (!desktopWindowVisible() || !behaviorEnabled.value || dnd.value || behavior.inQuietHours()) { eventDetector.reset(); return }
    const character = activeChar.value
    eventPolling = true
    const controller = new AbortController()
    eventPollController = controller
    try {
      const [status, imageCount] = await Promise.all([
        controlApi.getStatus({ signal: controller.signal }).catch(() => null),
        import('@/storage/artworkRepository').then(({ artworkRepository }) => artworkRepository.countImages()).catch(() => -1),
      ])
      if (!alive || controller.signal.aborted || !status || status.ok === false || character !== activeChar.value || !desktopWindowVisible()) return
      const events = eventDetector.ingest({
        imageCount: imageCount >= 0 ? imageCount : null,
        services: {
          sdOnline: status.sdOnline,
          ttsOnline: status.ttsOnline,
          ollamaOnline: status.ollamaOnline,
        },
      })
      for (const event of events) {
        eventLineOffset += 1
        const line = pickCompanionLine(activeChar.value, 'event', eventLineOffset, event)
        const reminder = behavior.noteEvent(event, line)
        if (reminder) {
          syncReminders()
          if (desktopBridge) void Promise.resolve(desktopBridge.notify(EVENT_NOTIFY_TITLE[event], line)).catch(() => {})
        }
      }
    } catch {
      // 轮询失败静默：下次再试
    } finally {
      if (eventPollController === controller) eventPollController = null
      eventPolling = false
    }
  }

  function openReminderRoute(reminder: CompanionReminder) {
    if (reminder.kind !== 'event' || !reminder.eventKind) return
    const route = EVENT_ROUTE[reminder.eventKind as CompanionDetectedEvent]
    if (!route) return
    if (desktopBridge) {
      dismissReminder(reminder.id)
      desktopBridge.openAtelier(route)
    }
  }

  /** 导入/剪贴板入册后图片计数增加：重置检测器基线避免误报 sd-done。 */
  function resetEventDetector() {
    eventDetector.reset()
  }

  function onBehaviorStorage(event: StorageEvent) {
    if (event.key !== null && event.key !== COMPANION_BEHAVIOR_KEY) return
    config.value = readBehaviorConfig()
    behavior.setConfig(config.value)
    dnd.value = config.value.dnd
    syncReminders()
    reconcileAutoListen()
  }
  watch(activeChar, () => {
    eventPollController?.abort()
    behavior.clear(); eventDetector.reset(); greetedSlotKey = ''
    syncReminders(); maybeGreetByTime()
  })

  onMounted(() => {
    dnd.value = behavior.config().dnd
    window.addEventListener('storage', onBehaviorStorage)
    behaviorPoll.start()
    eventPoll.start()
    syncReminders()
    maybeGreetByTime()
    void pollCompanionEvents()
  })

  onUnmounted(() => {
    alive = false
    eventPollController?.abort()
    window.removeEventListener('storage', onBehaviorStorage)
    eventPollController = null
    behaviorPoll.stop()
    eventPoll.stop()
  })

  return {
    behaviorEnabled,
    dnd,
    pendingReminders,
    inQuietHours,
    quietHoursText,
    noteActivity,
    getLastActivityAt,
    getIdleMinutes,
    noteReturn,
    noteReturnPlain,
    toggleDnd,
    dismissReminder,
    maybeGreetByTime,
    openReminderRoute,
    resetEventDetector,
  }
}
