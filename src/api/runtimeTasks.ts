import { apiClient, ApiClientError } from './client'
import { desktopRuntimeFetch, getDesktopRuntime, onDesktopRuntime } from '../platform/desktop/runtime.ts'
import type { TaskRecord, TaskSubmission, TaskSummary, TaskListScope, TaskPage } from '../../types/tasks'
import { runtimeTasksEnabled, runtimeTaskError, runtimeMangaRetryKey, markTaskRequestSubmitting, releaseUnsubmittedTaskRequest, mergeTasks, rememberTask, forgetTaskRequest, clearRuntimeTasks, resetRuntimeTaskWorkspace } from '../stores/runtimeTaskState'
import { hasRuntimeTasks, assertRuntimeTaskSession } from './runtimeTaskAuthority'
import { AcceptedTaskTerminalError, TaskSubmissionRejected } from './acceptedTaskOutcome'
import { summarizeTask } from '../utils/runtimeTaskSummary'
import { downloadBlob } from '../utils/downloadBlob'
import { rememberWorkspaceMedia, workspaceMediaAuthority, assertWorkspaceMediaAuthority } from '../platform/desktop/workspaceMediaSource'
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
function parseRuntimeResultPath(url: string) {
  const match = /^\/api\/tasks\/v1\/([\w-]+)\/results\/(0|[1-9]\d*)$/.exec(url)
  return match && Number.isSafeInteger(Number(match[2])) ? { taskId: match[1], index: Number(match[2]) } : null
}
export const isRuntimeResultPath = (url: string) => parseRuntimeResultPath(url) !== null

function remember(task: TaskRecord): TaskRecord { return rememberTask(task, epoch()) }
async function request<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal, onSubmitting?: () => void): Promise<T> {
  ensureAuthority()
  signal?.throwIfAborted()
  const expected = epoch()
  onSubmitting?.()
  const response = await apiClient.request<{ result: T; runtimeEpoch: string }>(base + path, {
    method, body, signal, cache: 'no-store', cachePolicy: 'bypass', timeoutMs: method === 'POST' && (path === '' || path.endsWith('/retry')) ? 150_000 : method === 'POST' && path.endsWith('/concat') ? 120_000 : 30_000,
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
interface TaskObservation { signal?: AbortSignal; onSubmitting?: () => void }
/** Acceptance is one POST followed only by lookups in the same runtime session. */
async function acceptedTaskRequest(path: string, body: unknown, key: string, observation: TaskObservation,
  validate: (task: TaskRecord) => void = () => {}): Promise<TaskRecord> {
  let submitting = false
  const expected = epoch()
  const received = (task: TaskRecord) => {
    if (task.requestKey !== key) throw new Error('接收记录与原操作编号不符，请到任务中心核对')
    validate(task)
    return remember(task)
  }
  try { return received(await request<TaskRecord>(path, 'POST', body, observation.signal, () => {
    observation.onSubmitting?.()
    markTaskRequestSubmitting(key); submitting = true
  })) }
  catch (error) {
    if (!submitting) { releaseUnsubmittedTaskRequest(key); throw new TaskSubmissionRejected(key, error instanceof Error ? error.message : String(error)) }
    if (expected === epoch() && error instanceof ApiClientError && error.kind === 'http' && error.responseBody?.submissionNotAccepted === true) {
      forgetTaskRequest(key)
      throw new TaskSubmissionRejected(key, error.message, error.code)
    }
    if (observation.signal?.aborted || expected !== epoch()) throw error
    // Losing the acceptance response only permits lookup by the original key.
    // It never causes a second POST or a replacement key.
    const found = await request<TaskRecord | null>('/by-key/' + encodeURIComponent(key), 'GET', undefined, observation.signal).catch(() => null)
    if (observation.signal?.aborted || expected !== epoch()) throw error
    if (found) return received(found)
    throw new ApiClientError('接收结果尚未确认。请在任务中心查询，避免重复生成。', { kind: 'network', code: 'TASK_ACCEPTANCE_UNKNOWN' })
  }
}
export function submitRuntimeTask(kind: TaskRecord['kind'], input: Record<string, unknown>, key: string, context?: Record<string, unknown>,
  observation: TaskObservation = {}): Promise<TaskRecord> {
  return acceptedTaskRequest('', { kind, input, requestKey: key, context } satisfies TaskSubmission, key, observation,
    task => { if (task.kind !== kind) throw new Error('接收记录与任务类型不符，请到任务中心核对') })
}
export async function getRuntimeTask(id: string, signal?: AbortSignal) { return remember(await request<TaskRecord>('/' + encodeURIComponent(id), 'GET', undefined, signal)) }
export async function retryRuntimeMangaTask(source: TaskSummary, signal?: AbortSignal): Promise<TaskRecord> {
  assertRuntimeTaskSession(source)
  const key = runtimeMangaRetryKey(source)
  return acceptedTaskRequest(`/${encodeURIComponent(source.taskId)}/retry`, {}, key, { signal }, task => {
    if (task.kind !== source.kind || task.metadata.retryOfTaskId !== source.taskId) throw new Error('重试记录与原任务不符，请重新核对')
  })
}
export async function getRuntimeTaskSummary(id: string, signal?: AbortSignal): Promise<TaskSummary> {
  const task = await request<TaskSummary>('/' + encodeURIComponent(id) + '?summary=true', 'GET', undefined, signal)
  mergeTasks([task], epoch())
  return task
}
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
export async function cancelRuntimeTaskKey(key: string, signal?: AbortSignal) {
  const task = await request<TaskRecord | null>('/by-key/' + encodeURIComponent(key), 'DELETE', undefined, signal)
  if (task) remember(task)
  else if (task === null) forgetTaskRequest(key)
  else throw new Error('取消回执无效，原请求状态仍待核对')
  return task
}
/** Missing reads prove nothing. A committed cancel intent fences late acceptance. */
export async function recoverRuntimeTaskRequest(key: string, signal?: AbortSignal): Promise<TaskRecord> {
  const expected = epoch()
  const existing = await getRuntimeTaskByKey(key, signal)
  if (existing) return existing
  if (existing !== null || expected !== epoch()) throw new Error('原请求状态仍待核对，请恢复原连接后重试')
  const cancelled = await cancelRuntimeTaskKey(key, signal)
  if (cancelled) return cancelled
  throw new TaskSubmissionRejected(key, '原请求已保存取消意图并安全结算，可重试或重置。', 'TASK_REQUEST_CANCELLED')
}
export async function cancelRuntimeTask(id: string, signal?: AbortSignal) {
  const task = await getRuntimeTask(id, signal)
  assertRuntimeTaskSession(task)
  return cancelRuntimeTaskKey(task.requestKey, signal)
}
export async function actOnRuntimeTask(id: string, action: 'reconcile' | 'resume' | 'continue' | 'concat', signal?: AbortSignal) {
  return remember(await request<TaskRecord>(`/${encodeURIComponent(id)}/${action}`, 'POST', {}, signal))
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
  if (task.errorCode === 'NATIVE_RESTART_INTERRUPTED') return task.kind === 'manga' || task.kind === 'lineart'
    ? '原生处理因重启中断，未自动重跑。核对结束后可用已保存的原图和参数重试。待主力机验证。'
    : '原生处理因重启中断，未自动重跑。请返回入口重新发起；适配待主力机验证。'
  if (task.errorCode === 'MANGA_RESULT_INCOMPLETE') return '重启前仅保存了部分结果；已保存图片仍可查看、导出或入册，其余未恢复。待主力机验证。'
  if (task.errorCode === 'TASK_RESUME_UNSAFE') return '恢复条件不足，原输入或运行环境不可用。请返回入口重新发起，或取消原任务。'
  if (task.errorCode === 'RESULT_COLLECTION_PENDING') return '处理已结束，结果保存等待重试；会继续收取同一结果，不会重新运行模型。'
  if ((task.kind === 'manga' || task.kind === 'lineart') && task.status === 'failed') {
    if (task.errorCode?.startsWith('MANGA_DEPENDENCY')) return '漫画处理环境缺少依赖或版本不符，请按漫画环境说明准备依赖后重试。待主力机验证。'
    return `漫画或线稿任务未完成${task.errorCode ? `（${task.errorCode}）` : ''}，请核对原生环境后重试。待主力机验证。`
  }
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
export async function waitForRuntimeTask(id: string, signal: AbortSignal, update: (task: TaskSummary) => void,
  options: { timeoutMs?: number; onDetail?: (task: TaskRecord) => void } = {}): Promise<TaskRecord> {
  const deadline = options.timeoutMs === undefined ? Infinity : Date.now() + options.timeoutMs
  for (;;) {
    signal.throwIfAborted()
    let detail = options.onDetail ? await getRuntimeTask(id, signal) : undefined
    let task: TaskSummary = detail ?? await getRuntimeTaskSummary(id, signal)
    if (!detail && task.upstreamSettled && task.status === 'succeeded' && task.resultState === 'available'
      && task.recoveryState !== 'unknown' && task.recoveryState !== 'interrupted') {
      // Only successful delivery needs the full recipe/checkpoint. Recheck the
      // newer detail below so a concurrent discard cannot return stale success.
      detail = await getRuntimeTask(id, signal)
      if (detail.runtimeEpoch !== task.runtimeEpoch) throw new ApiClientError('运行时连接已更换', { kind: 'aborted', code: 'RUNTIME_EPOCH_CHANGED' })
      task = detail
    }
    signal.throwIfAborted()
    if (detail) options.onDetail?.(detail)
    update(task)
    if (task.upstreamSettled && (task.status === 'failed' || task.status === 'cancelled')) throw new AcceptedTaskTerminalError(task.taskId, task.status, taskMessage(task))
    if (task.recoveryState === 'unknown' || task.recoveryState === 'interrupted') throw new Error(taskMessage(task))
    if (task.upstreamSettled) {
      if (task.status === 'succeeded' && task.resultState === 'available' && detail) return detail
      throw new Error(taskMessage(task))
    }
    if (Date.now() >= deadline) throw new Error('本次查看已超时，任务仍保留在任务中心，可重新连接')
    await new Promise<void>((resolve, reject) => {
      const stop = () => { clearTimeout(timer); signal.removeEventListener('abort', stop); reject(new DOMException('停止查看', 'AbortError')) }
      const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve() }, 1000)
      signal.addEventListener('abort', stop, { once: true })
    })
  }
}
/** Known records avoid another GET, never the output and session checks. */
export async function resolveRuntimeResult(url: string, signal?: AbortSignal, knownTask?: TaskRecord) {
  ensureAuthority(); signal?.throwIfAborted()
  const result = parseRuntimeResultPath(url)
  if (!result) throw new Error('结果地址无效')
  const authority = workspaceMediaAuthority()
  const task = knownTask ?? await getRuntimeTask(result.taskId, signal)
  signal?.throwIfAborted(); assertWorkspaceMediaAuthority(authority); assertRuntimeTaskSession(task)
  if (task.taskId !== result.taskId) throw new Error('任务结果来源与原地址不符')
  const media = task.resultRefs.find(value => value.index === result.index)
  if (!media || typeof media.alias !== 'string' || !media.alias || typeof media.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(media.sha256)
    || !Number.isSafeInteger(media.bytes) || media.bytes <= 0 || typeof media.mime !== 'string' || !/^(image|video)\//.test(media.mime))
    throw new Error('任务结果来源信息不完整，请重新读取')
  return Object.freeze({ path: url, authority, media: Object.freeze({ ...media }) })
}
async function readRuntimeResult(source: Awaited<ReturnType<typeof resolveRuntimeResult>>, signal?: AbortSignal): Promise<Blob> {
  assertWorkspaceMediaAuthority(source.authority)
  const requestSignal = AbortSignal.any([AbortSignal.timeout(120_000), ...(signal ? [signal] : [])])
  const response = await desktopRuntimeFetch(source.path, { cache: 'no-store', signal: requestSignal })
  try {
    if (!response.ok) throw new Error('任务结果暂时无法读取')
    const media = source.media
    if (response.headers.get('X-Workspace-Media-Sha256') !== media.sha256
      || Number(response.headers.get('X-Workspace-Media-Total-Bytes')) !== media.bytes
      || response.headers.get('X-Workspace-Media-Mime') !== media.mime
      || response.headers.get('X-Workspace-Media-Offset') !== '0') throw new Error('任务结果来源信息不一致，请重新读取')
    const blob = await response.blob()
    requestSignal.throwIfAborted(); assertWorkspaceMediaAuthority(source.authority)
    rememberWorkspaceMedia(blob, media, source.authority)
    return blob
  } finally {
    if (!response.bodyUsed) await response.body?.cancel().catch(() => {})
  }
}
export async function fetchRuntimeResult(url: string, signal?: AbortSignal, knownTask?: TaskRecord): Promise<Blob> {
  return readRuntimeResult(await resolveRuntimeResult(url, signal, knownTask), signal)
}
export async function downloadTaskMedia(url: string, filename = '绘遇结果', signal?: AbortSignal) {
  const source = await resolveRuntimeResult(url, signal)
  const blob = await readRuntimeResult(source, signal)
  signal?.throwIfAborted(); assertWorkspaceMediaAuthority(source.authority)
  downloadBlob(blob, filename)
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
