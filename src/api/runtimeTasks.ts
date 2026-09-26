import { apiClient, ApiClientError } from './client'
import { desktopRuntimeFetch, getDesktopRuntime, onDesktopRuntime } from '../platform/desktop/runtime.ts'
import type { TaskRecord, TaskSubmission } from '../../types/tasks'
import { taskRecords, copyTask, runtimeTasksEnabled, runtimeTaskError, unresolvedTaskRequests as unresolved, pendingTaskRequests } from './runtimeTaskState'
import { hasRuntimeTasks, runtimeRequestKey } from './runtimeTaskAuthority'
export { runtimeTasks, runtimeTasksEnabled, runtimeTaskError, runtimeTaskActiveCount, pendingTaskRequests } from './runtimeTaskState'
export { hasRuntimeTasks, isRuntimeTaskId, runtimeRequestKey } from './runtimeTaskAuthority'
export type { TaskRecord } from '../../types/tasks'

const base = '/api/tasks/v1'
let activeEpoch = '', activeWorkspace = '', sequence = 0, activeRead = 0
function epoch() { return getDesktopRuntime().bootstrap?.runtime?.workspace?.runtimeEpoch || '' }
function ensureAuthority() {
  if (!hasRuntimeTasks()) throw new Error('私人任务工作区尚未启用')
  if (getDesktopRuntime().connection !== 'ready') throw new Error('本地运行时已断开，任务记录已保留，请恢复连接后重试。')
}
export const runtimeResultPath = (task: TaskRecord, index = 0) => `${base}/${encodeURIComponent(task.taskId)}/results/${index}`
export const isRuntimeResultPath = (url: string) => /^\/api\/tasks\/v1\/[\w-]+\/results\/\d+$/.test(url)

function remember(task: TaskRecord): TaskRecord {
  if (task.runtimeEpoch !== epoch()) throw new Error('运行时已更换，请重新读取任务')
  const current = taskRecords.value.find(value => value.taskId === task.taskId)
  if (!current || current.runtimeEpoch !== task.runtimeEpoch || current.revision <= task.revision) {
    taskRecords.value = [copyTask(task), ...taskRecords.value.filter(value => value.taskId !== task.taskId)].sort((a, b) => b.createdAt - a.createdAt)
  }
  for (const [input, pending] of unresolved) if (pending.key === task.requestKey) unresolved.delete(input)
  pendingTaskRequests.value = [...unresolved.values()]
  return copyTask(current && current.runtimeEpoch === task.runtimeEpoch && current.revision > task.revision ? current : task)
}
async function request<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  ensureAuthority()
  const expected = epoch()
  const response = await apiClient.request<{ result: T; runtimeEpoch: string }>(base + path, {
    method, body, signal, cache: 'no-store', cachePolicy: 'bypass', timeoutMs: method === 'POST' && path.endsWith('/concat') ? 120_000 : 30_000,
  })
  if (expected !== epoch() || response.runtimeEpoch !== expected) throw new ApiClientError('运行时连接已更换', { kind: 'aborted', code: 'RUNTIME_EPOCH_CHANGED' })
  return response.result
}
export async function refreshRuntimeTasks(signal?: AbortSignal): Promise<void> {
  if (!hasRuntimeTasks()) return
  const read = ++sequence; activeRead = read
  try {
    const list = await request<{ items: TaskRecord[] }>('', 'GET', undefined, signal)
    if (read !== activeRead) return
    for (const task of list.items) remember(task)
    runtimeTaskError.value = ''
  } catch (error) { if (!signal?.aborted) runtimeTaskError.value = error instanceof Error ? error.message : '任务暂时无法读取'; throw error }
}
export async function submitRuntimeTask(kind: TaskRecord['kind'], input: Record<string, unknown>, key = runtimeRequestKey(kind, input), context?: Record<string, unknown>): Promise<TaskRecord> {
  try { return remember(await request<TaskRecord>('', 'POST', { kind, input, requestKey: key, context } satisfies TaskSubmission)) }
  catch (error) {
    // Losing the acceptance response only permits lookup by the original key.
    // It never causes a second POST or a replacement key.
    if (error instanceof ApiClientError && error.kind === 'http' && error.status < 500) {
      for (const [inputId, pending] of unresolved) if (pending.key === key) unresolved.delete(inputId)
      pendingTaskRequests.value = [...unresolved.values()]; throw error
    }
    const found = await request<TaskRecord | null>('/by-key/' + encodeURIComponent(key)).catch(() => null)
    if (found) return remember(found)
    throw new ApiClientError('接收结果尚未确认。请在任务中心查询，避免重复生成。', { kind: 'network', code: 'TASK_ACCEPTANCE_UNKNOWN' })
  }
}
export async function getRuntimeTask(id: string, signal?: AbortSignal) { return remember(await request<TaskRecord>('/' + encodeURIComponent(id), 'GET', undefined, signal)) }
export async function readRuntimeTaskHistory(): Promise<unknown> {
  const { snapshots } = await request<{ snapshots: unknown[] }>('/legacy-history')
  const records: unknown[] = []; const deleted: Record<string, number> = {}
  for (const snapshot of snapshots) {
    if (Array.isArray(snapshot)) records.push(...snapshot)
    else if (snapshot && typeof snapshot === 'object') {
      const value = snapshot as { records?: unknown[]; deleted?: Record<string, number> }
      if (Array.isArray(value.records)) records.push(...value.records)
      for (const [id, timestamp] of Object.entries(value.deleted || {})) if (typeof timestamp === 'number') deleted[id] = Math.max(timestamp, deleted[id] || 0)
    }
  }
  return { version: 1, records, deleted }
}
export async function cancelRuntimeTaskKey(key: string) {
  const task = await request<TaskRecord | null>('/by-key/' + encodeURIComponent(key), 'DELETE')
  if (task) remember(task)
  return task
}
export async function cancelRuntimeTask(id: string) { return cancelRuntimeTaskKey((await getRuntimeTask(id)).requestKey) }
export async function actOnRuntimeTask(id: string, action: 'reconcile' | 'resume' | 'continue' | 'concat') {
  return remember(await request<TaskRecord>(`/${encodeURIComponent(id)}/${action}`, 'POST', {}))
}
export async function markRuntimeTask(id: string, state: TaskRecord['deliveryState']) {
  return remember(await request<TaskRecord>(`/${encodeURIComponent(id)}/delivery`, 'PATCH', { state }))
}
export function taskMessage(task: TaskRecord): string {
  if (task.deliveryState === 'discarded') return '结果已移出收件箱，已入册作品保留。'
  if (task.recoveryState === 'unknown') return task.errorCode === 'BATCH_AWAITING_EXPLICIT_CONTINUE' ? '已发镜头已核对，等待你继续剩余分镜。' : '状态尚未确认，已保留任务和输出。可重新核对，不会自动重发。'
  if (task.recoveryState === 'interrupted') return '尚未提交，等待你确认继续。'
  if (task.status === 'cancelling') return '取消意图已记录，正在等待上游结束。'
  if (task.resultState === 'available') return task.deliveryState === 'saved' ? '结果已入册。' : '结果已保存在收件箱，尚未入册。'
  if (task.resultState === 'unavailable') return '生成已经结束，结果暂时无法取回，可重新核对。'
  if (task.status === 'failed') return '任务未完成，请检查生成环境后重新发起。'
  return ({ queued: '任务已接收。', submitting: '正在提交生成。', running: '正在生成，可切换页面。', succeeded: '正在收取结果。', cancelled: '任务已取消。' } as Record<string, string>)[task.status] || ''
}
export async function waitForRuntimeTask(id: string, signal: AbortSignal, update: (task: TaskRecord) => void): Promise<TaskRecord> {
  for (;;) {
    signal.throwIfAborted()
    const task = await getRuntimeTask(id, signal)
    signal.throwIfAborted(); update(task)
    if (task.recoveryState === 'unknown' || task.recoveryState === 'interrupted') throw new Error(taskMessage(task))
    if (task.upstreamSettled) {
      if (task.status === 'succeeded' && task.resultState === 'available') return task
      if (task.status === 'cancelled') throw new DOMException('任务已取消', 'AbortError')
      throw new Error(taskMessage(task))
    }
    await new Promise<void>((resolve, reject) => {
      const stop = () => { clearTimeout(timer); signal.removeEventListener('abort', stop); reject(new DOMException('停止查看', 'AbortError')) }
      const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve() }, 1000)
      signal.addEventListener('abort', stop, { once: true })
    })
  }
}
export async function fetchRuntimeResult(url: string, signal?: AbortSignal): Promise<Blob> {
  ensureAuthority()
  if (!isRuntimeResultPath(url)) throw new Error('结果地址无效')
  const response = await desktopRuntimeFetch(url, { cache: 'no-store', signal: AbortSignal.any([AbortSignal.timeout(120_000), ...(signal ? [signal] : [])]) })
  if (!response.ok) throw new Error('任务结果暂时无法读取')
  const blob = await response.blob()
  if (!blob.size || !/^(image|video)\//.test(blob.type)) throw new Error('任务结果格式无效')
  return blob
}
export async function downloadTaskMedia(url: string, filename = '绘遇结果') {
  const blob = await fetchRuntimeResult(url)
  const objectUrl = URL.createObjectURL(blob)
  const anchor = document.createElement('a'); anchor.href = objectUrl; anchor.download = filename; anchor.click()
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
}
/** One application subscription; page controllers own only their cancellable reads. */
export function startRuntimeTaskPolling(): () => void {
  let controller = new AbortController(), loading = false
  const refresh = async () => { if (loading || !hasRuntimeTasks()) return; loading = true; try { await refreshRuntimeTasks(controller.signal) } catch {} finally { loading = false } }
  const unsubscribe = onDesktopRuntime(() => {
    runtimeTasksEnabled.value = hasRuntimeTasks()
    const next = epoch()
    const workspace = getDesktopRuntime().bootstrap?.runtime?.workspace?.workspaceId || ''
    if (workspace && activeWorkspace && workspace !== activeWorkspace) { taskRecords.value = []; unresolved.clear(); pendingTaskRequests.value = [] }
    if (workspace) activeWorkspace = workspace
    if (activeEpoch !== next) { activeEpoch = next; activeRead = ++sequence; controller.abort(); controller = new AbortController(); if (!runtimeTasksEnabled.value) taskRecords.value = [] }
    if (runtimeTasksEnabled.value) void refresh()
  })
  const timer = setInterval(() => { void refresh() }, 2500)
  return () => { unsubscribe(); controller.abort(); clearInterval(timer) }
}
