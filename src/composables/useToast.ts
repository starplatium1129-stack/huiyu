import { ref, readonly } from 'vue'
import { playInterfaceTone, type InterfaceTone } from '@/composables/useInterfaceFeedback'

export type ToastType = 'info' | 'success' | 'error' | 'warning'

/** 可选内联动作（如删除后的「撤销」）。点击即关 toast 并执行回调。 */
export interface ToastAction {
  label: string
  onClick: () => void
}

export interface ToastItem {
  id: number
  msg: string
  type: ToastType
  duration: number
  remaining: number
  startedAt: number
  timer?: ReturnType<typeof setTimeout>
  action?: ToastAction
}

const toasts = ref<ToastItem[]>([])
let nextId = 0
let listenersInstalled = false
const pauseReasons = new Set<string>()
let coveredIds = new Set<number>()

/**
 * 同屏最多留几条（2026-08-30 UX 审计 P2）。
 *
 * 批量失败、轮询报错这类场景会在几秒内连发好几条，没有上限时整屏都是提示条，
 * 把正在操作的内容全挡住。超过就挤掉最旧的——但见下方 trimToasts 的例外。
 */
const MAX_VISIBLE = 4

/**
 * 超出上限时挤掉多余提示，优先牺牲没有内联动作的。
 *
 * 带 action 的那几条（比如删除后的「撤销」）是用户可能还要点的入口，随手清掉
 * 等于把撤销机会弄丢；如果满屏都是带动作的，宁可多堆几条也不删。
 */
function trimToasts() {
  while (toasts.value.length > MAX_VISIBLE) {
    // 只在「除最后一条之外」的范围里找牺牲品：最后一条是刚来的，不能刚出现
    // 就被自己挤掉。slice 从 0 开始，索引可以直接用在原数组上。
    const victimIndex = toasts.value.slice(0, -1).findIndex(t => !t.action)
    if (victimIndex < 0) break
    const [victim] = toasts.value.splice(victimIndex, 1)
    if (victim.timer) clearTimeout(victim.timer)
  }
}

function pauseToast(t: ToastItem) {
  if (t.timer) {
    clearTimeout(t.timer)
    t.timer = undefined
    const elapsed = Date.now() - t.startedAt
    t.remaining = Math.max(200, t.remaining - elapsed)
  }
}

function resumeToast(t: ToastItem) {
  if (!t.timer && t.remaining > 0 && !coveredIds.has(t.id)) {
    t.startedAt = Date.now()
    t.timer = setTimeout(() => dismiss(t.id), t.remaining)
  }
}

/** Covered notices retain their reading/action time until brought to the front. */
function coverToasts(ids: number[]) {
  coveredIds = new Set(ids)
  for (const item of toasts.value) {
    if (coveredIds.has(item.id)) pauseToast(item)
    else if (!pauseReasons.size && !document.hidden) resumeToast(item)
  }
}

function pauseAllToasts(reason = 'manual') {
  pauseReasons.add(reason)
  toasts.value.forEach(pauseToast)
}

function resumeAllToasts(reason = 'manual') {
  pauseReasons.delete(reason)
  if (pauseReasons.size || document.hidden) return
  toasts.value.forEach(resumeToast)
}

function ensureListeners() {
  if (listenersInstalled || typeof document === 'undefined') return
  listenersInstalled = true
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pauseAllToasts('visibility')
    else resumeAllToasts('visibility')
  })
}

function dismiss(id: number) {
  const idx = toasts.value.findIndex(t => t.id === id)
  if (idx >= 0) {
    const item = toasts.value[idx]
    if (item.timer) clearTimeout(item.timer)
    toasts.value.splice(idx, 1)
  }
}

export function useToast() {
  ensureListeners()

  function show(msg: string, type: ToastType = 'info', duration = 2800, action?: ToastAction) {
    const id = ++nextId
    const item: ToastItem = {
      id,
      msg,
      type,
      duration,
      remaining: duration,
      startedAt: Date.now(),
      action,
    }
    item.timer = setTimeout(() => dismiss(id), duration)
    if (pauseReasons.size || document.hidden) pauseToast(item)
    toasts.value.push(item)
    trimToasts()

    const tones: Record<ToastType, InterfaceTone> = {
      info: 'tap', success: 'success', error: 'warning', warning: 'warning',
    }
    playInterfaceTone(tones[type])
  }

  const success = (msg: string, d?: number) => show(msg, 'success', d)
  const error   = (msg: string, d?: number) => show(msg, 'error',   d ?? 4000)
  const warning = (msg: string, d?: number) => show(msg, 'warning', d)
  const info    = (msg: string, d?: number) => show(msg, 'info',    d)

  return {
    toasts: readonly(toasts),
    show,
    dismiss,
    pauseAll: pauseAllToasts,
    resumeAll: resumeAllToasts,
    coverToasts,
    success,
    error,
    warning,
    info,
  }
}
