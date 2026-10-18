import { ApiClientError } from './client'
import { acceptDirectGenerationRequest, cancelDirectGenerationRequest } from './directGenerationRequests'
import { hasRuntimeTasks, getRuntimeTaskByKey, submitRuntimeTask, cancelRuntimeTaskKey, type TaskRecord } from './runtimeTasks'
import { taskVideoBatch, taskVideoJob } from './runtimeVideo'
import { videoBatchResponse, videoJobResponse } from './videoApiResponse'
import { assertRequestOwner } from '@/storage/requestDraft'
import type { TaskRequestDraft } from '@/storage/taskRequestDraft'
import type { VideoBatch, VideoJob } from './videoApi'

type VideoRequestResult = VideoJob | VideoBatch
interface RetrySource { batchId: string; indices: number[] }
function retrySource(draft: TaskRequestDraft): RetrySource | null {
  const value = draft.details?.retrySource
  if (value === undefined) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('原重抽来源无效，已保留请求身份')
  const source = value as Partial<RetrySource>
  if (draft.kind !== 'batch' || typeof source.batchId !== 'string' || !source.batchId
    || !Array.isArray(source.indices) || !source.indices.length || new Set(source.indices).size !== source.indices.length
    || source.indices.some(index => !Number.isSafeInteger(index) || index < 1)) throw new Error('原重抽镜头编号无效，已保留请求身份')
  return { batchId: source.batchId, indices: [...source.indices] }
}
function assertVideoRequest(draft: TaskRequestDraft) {
  assertRequestOwner(draft, hasRuntimeTasks())
  if (draft.kind !== 'video' && draft.kind !== 'batch') throw new Error('原请求不是视频任务，已停止操作')
}
function checkResult(draft: TaskRequestDraft, result: VideoRequestResult): VideoRequestResult {
  assertVideoRequest(draft)
  if (draft.taskId && draft.taskId !== result.id)
    throw new ApiClientError('视频接收编号与原请求不符，请核对原任务。', { kind: 'invalid-response' })
  return result
}
function runtimeResult(draft: TaskRequestDraft, task: TaskRecord): VideoRequestResult {
  if (task.requestKey !== draft.key || task.kind !== draft.kind) throw new Error('视频接收记录与原请求不符')
  const source = retrySource(draft)
  if (source) {
    const context = task.metadata.context as Record<string, unknown> | undefined
    if (context?.retriedTaskId !== source.batchId || JSON.stringify(context.stepIndices) !== JSON.stringify(source.indices.map(index => index - 1)))
      throw new Error('重抽接收记录与原镜头不符，请在任务中心核对')
  }
  return checkResult(draft, draft.kind === 'video' ? taskVideoJob(task) : taskVideoBatch(task))
}
function directRequest(draft: TaskRequestDraft) {
  const source = retrySource(draft), field = draft.kind === 'video' ? 'job' as const : 'batch' as const
  return {
    key: draft.key, field,
    submitPath: source ? `/api/video/batches/${encodeURIComponent(source.batchId)}/retry` : `/api/video/${field === 'job' ? 'jobs' : 'batches'}`,
    receiptPath: `/api/video/${field === 'job' ? 'requests' : 'batch-requests'}/${encodeURIComponent(draft.key)}`,
    body: source ? { indices: source.indices } : draft.input,
    decode: (value: Record<string, unknown>) => checkResult(draft, field === 'job' ? videoJobResponse(value).job : videoBatchResponse(value).batch),
  }
}
/** Admission owns exactly one caller-persisted identity; restoration never sends POST. */
export async function acceptVideoRequest(draft: TaskRequestDraft, options: {
  signal: AbortSignal; resume?: boolean; onSubmitting?: () => void
}): Promise<VideoRequestResult> {
  options.signal.throwIfAborted(); assertVideoRequest(draft)
  if (draft.transport === 'direct') return acceptDirectGenerationRequest(directRequest(draft), options)
  const task = options.resume ? await getRuntimeTaskByKey(draft.key, options.signal)
    : await submitRuntimeTask(draft.kind as 'video' | 'batch', draft.input, draft.key, draft.context, options)
  if (!task) throw new Error('原视频接收状态尚未确认，请再次查询原请求；不会重新提交。')
  return runtimeResult(draft, task)
}
/** A missing task ID still permits cancellation of the original saved identity. */
export async function cancelVideoRequest(draft: TaskRequestDraft, signal?: AbortSignal): Promise<VideoRequestResult | null> {
  signal?.throwIfAborted(); assertVideoRequest(draft)
  if (draft.transport === 'direct') return cancelDirectGenerationRequest(directRequest(draft), { signal })
  const task = await cancelRuntimeTaskKey(draft.key, signal)
  assertVideoRequest(draft)
  return task ? runtimeResult(draft, task) : null
}
