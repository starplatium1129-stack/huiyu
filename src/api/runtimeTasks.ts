import { apiClient, ApiClientError } from './client'
import { desktopRuntimeFetch, getDesktopRuntime, onDesktopRuntime } from '../platform/desktop/runtime.ts'
import type { TaskRecord, TaskSubmission, TaskSummary, TaskListScope, TaskPage } from '../../types/tasks'
import { runtimeTasksEnabled, runtimeTaskError, runtimeRequestKey, mergeTasks, rememberTask, forgetTaskRequest, clearRuntimeTasks, resetRuntimeTaskWorkspace } from '../stores/runtimeTaskState'
import { hasRuntimeTasks } from './runtimeTaskAuthority'
import { AcceptedTaskTerminalError } from './acceptedTaskOutcome'
import { summarizeTask } from '../utils/runtimeTaskSummary'
export { hasRuntimeTasks, isRuntimeTaskId } from './runtimeTaskAuthority'
export type { TaskRecord, TaskSummary } from '../../types/tasks'

const base = '/api/tasks/v1'
let activeEpoch = '', activeWorkspace = '', sequence = 0, activeRead = 0
let readEpoch = '', readRevision = 0
function epoch() { return getDesktopRuntime().bootstrap?.runtime?.workspace?.runtimeEpoch || '' }
function ensureAuthority() {
  if (!hasRuntimeTasks()) throw new Error('私人任务工作区尚未启用')
  if (getDesktopRuntime().connection !== 'ready') throw new Error('本地运行时已断开，任务记录已保留，请恢复连接后重试。')
}
export const runtimeResultPath = (task: Pick<TaskRecord, 'taskId'>, index = 0) => `${base}/${encodeURIComponent(task.taskId)}/results/${index}`
export const isRuntimeResultPath = (url: string) => /^\/api\/tasks\/v1\/[\w-]+\/results\/\d+$/.test(url)

function remember(task: TaskRecord): TaskRecord { return rememberTask(task, epoch()) }
async function request<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal, onSubmitting?: () => void): Promise<T> {
  ensureAuthority()
  signal?.throwIfAborted()
  const expected = epoch()
  onSubmitting?.()
  const response = await apiClient.request<{ result: T; runtimeEpoch: string }>(base + path, {
    method, body, signal, cache: 'no-store', cachePolicy: 'bypass', timeoutMs: method === 'POST' && path.endsWith('/concat') ? 120_000 : 30_000,
  })
  if (expected !== epoch() || response.runtimeEpoch !== expected) throw new ApiClientError('运行时连接已更换', { kind: 'aborted', code: 'RUNTIME_EPOCH_CHANGED' })
  return response.result
}
export async function refreshRuntimeTasks(signal?: AbortSignal): Promise<void> {
  if (!hasRuntimeTasks()) return
  const read = ++sequence; activeRead = read
  const expected = epoch()
  try {
    const after = readEpoch === expected ? readRevision : 0
    const items: TaskSummary[] = []
    let before: number | null = null, through: number | undefined
    do {
      const params = new URLSearchParams({ afterRevision: String(after), limit: '100', summary: 'true', scope: after ? 'all' : 'overview' })
      if (before !== null) params.set('before', String(before))
      if (through !== undefined) params.set('throughRevision', String(through))
      const page = await request<TaskPage>('?' + params, 'GET', undefined, signal)
      if (read !== activeRead || expected !== epoch()) return
      if (!Number.isSafeInteger(page.throughRevision) || page.throughRevision < after || (through !== undefined && through !== page.throughRevision)
        || (page.nextCursor !== null && (!Number.isSafeInteger(page.nextCursor) || page.nextCursor <= after || (before !== null && page.nextCursor >= before)))) throw new Error('任务分页响应无效')
      items.push(...page.items)
      through = page.throughRevision
      before = page.nextCursor
    } while (before !== null)
    signal?.throwIfAborted()
    mergeTasks(items, expected, readEpoch !== expected)
    readEpoch = expected; readRevision = through!
    runtimeTaskError.value = ''
  } catch (error) {
    if (read === activeRead && expected === epoch() && !signal?.aborted) {
      runtimeTaskError.value = error instanceof Error ? error.message : '任务暂时无法读取'
    }
    throw error
  }
}
/** A bounded history page is separate from the active-task subscription and its delta cursor. */
export async function readRuntimeTaskPage(scope: TaskListScope, options: { before?: number; through?: number; limit?: number; signal?: AbortSignal } = {}): Promise<TaskPage> {
  const params = new URLSearchParams({ scope, summary: 'true', limit: String(options.limit ?? 30) })
  if (options.before !== undefined) params.set('before', String(options.before))
  if (options.through !== undefined) params.set('throughRevision', String(options.through))
  const page = await request<TaskPage>('?' + params, 'GET', undefined, options.signal)
  if (!Array.isArray(page.items) || !Number.isSafeInteger(page.throughRevision) || page.throughRevision < 0
    || (options.through !== undefined && page.throughRevision !== options.through)
    || (page.nextCursor !== null && (!Number.isSafeInteger(page.nextCursor) || page.nextCursor <= 0 || (options.before !== undefined && page.nextCursor >= options.before)))) throw new Error('任务分页响应无效')
  if (page.items.some(task => task.runtimeEpoch !== epoch())) throw new Error('运行时已更换，请重新读取任务')
  return { ...page, items: page.items.map(summarizeTask) }
}
export async function submitRuntimeTask(kind: TaskRecord['kind'], input: Record<string, unknown>, key = runtimeRequestKey(kind, input), context?: Record<string, unknown>,
  observation: { signal?: AbortSignal; onSubmitting?: () => void } = {}): Promise<TaskRecord> {
  try { return remember(await request<TaskRecord>('', 'POST', { kind, input, requestKey: key, context } satisfies TaskSubmission, observation.signal, observation.onSubmitting)) }
  catch (error) {
    if (observation.signal?.aborted) throw error
    // Losing the acceptance response only permits lookup by the original key.
    // It never causes a second POST or a replacement key.
    if (error instanceof ApiClientError && error.kind === 'http' && error.status < 500) {
      forgetTaskRequest(key); throw error
    }
    const found = await request<TaskRecord | null>('/by-key/' + encodeURIComponent(key)).catch(() => null)
    if (found) return remember(found)
    throw new ApiClientError('接收结果尚未确认。请在任务中心查询，避免重复生成。', { kind: 'network', code: 'TASK_ACCEPTANCE_UNKNOWN' })
  }
}
export async function getRuntimeTask(id: string, signal?: AbortSignal) { return remember(await request<TaskRecord>('/' + encodeURIComponent(id), 'GET', undefined, signal)) }
export async function getRuntimeTaskByKey(key: string, signal?: AbortSignal): Promise<TaskRecord | null> {
  const task = await request<TaskRecord | null>('/by-key/' + encodeURIComponent(key), 'GET', undefined, signal)
  return task ? remember(task) : null
}
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
export async function confirmWebuiTaskStopped(id: string, expectedRevision: number) {
  try { return remember(await request<TaskRecord>(`/${encodeURIComponent(id)}/confirm-webui-stopped`, 'POST', { expectedRevision, upstreamStopped: true })) }
  catch (error) {
    if (error instanceof ApiClientError && error.code === 'REVISION_CONFLICT') {
      await getRuntimeTask(id).catch(() => {})
      throw new Error('任务状态已经变化，请重新核对后再确认解除占用。')
    }
    throw error
  }
}
export async function markRuntimeTask(id: string, state: TaskRecord['deliveryState']) {
  return remember(await request<TaskRecord>(`/${encodeURIComponent(id)}/delivery`, 'PATCH', { state }))
}
export function taskMessage(task: TaskSummary): string {
  if (task.deliveryState === 'discarded') return '结果已移出收件箱，已入册作品保留。'
  if (task.errorCode === 'WEBUI_STOP_CONFIRMED') return task.resultState === 'available'
    ? '你已确认 WebUI 已停止或重启，任务占用已解除。已保存结果仍可查看和入册。'
    : '你已确认 WebUI 已停止或重启，任务占用已解除。原任务已保留，未取回的结果仍未确认。'
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
    if (task.upstreamSettled && (task.status === 'failed' || task.status === 'cancelled')) throw new AcceptedTaskTerminalError(task.taskId, task.status, taskMessage(task))
    if (task.recoveryState === 'unknown' || task.recoveryState === 'interrupted') throw new Error(taskMessage(task))
    if (task.upstreamSettled) {
      if (task.status === 'succeeded' && task.resultState === 'available') return task
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
    if (workspace && activeWorkspace && workspace !== activeWorkspace) resetRuntimeTaskWorkspace()
    if (workspace) activeWorkspace = workspace
    if (activeEpoch !== next) { activeEpoch = next; activeRead = ++sequence; controller.abort(); controller = new AbortController(); if (!runtimeTasksEnabled.value) clearRuntimeTasks() }
    if (runtimeTasksEnabled.value) void refresh()
  })
  const timer = setInterval(() => { void refresh() }, 2500)
  return () => { unsubscribe(); controller.abort(); clearInterval(timer) }
}
