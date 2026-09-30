import { ApiClientError } from '@/api/client'
import { AcceptedTaskTerminalError } from '@/api/acceptedTaskOutcome'
import { getRuntimeTaskByKey, waitForRuntimeTask, fetchRuntimeResult, runtimeResultPath, taskMessage } from '@/api/runtimeTasks'
import type { AnimaRequest } from '../generation/useAnimaSession'
import type { SDQueueJob } from '../generation/useSDQueue'
import type { BatchDrawRunnerInput, BatchDrawRunnerResult } from '../generation/useBatchDraw'
import type { usePromptBuilderStore } from '@/stores/promptBuilderStore'

type HistoryInput = Parameters<ReturnType<typeof usePromptBuilderStore>['commitHistoryEntry']>[0]
type HistorySnapshot = Omit<HistoryInput, 'blob'>
export type PreparedBatchImage = { adult: boolean; history: HistorySnapshot } & (
  { engine: 'sd'; job: Omit<SDQueueJob, 'id'>; disableLora: boolean }
  | { engine: 'anima' | 'krea2'; request: AnimaRequest; context: Record<string, unknown> }
)
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

export function readPreparedBatch(value: unknown): PreparedBatchImage | null {
  if (!record(value) || typeof value.adult !== 'boolean' || !record(value.history) || typeof value.history.prompt !== 'string') return null
  if (value.engine === 'sd') {
    if (!record(value.job) || typeof value.job.prompt !== 'string' || typeof value.job.size !== 'string'
      || typeof value.disableLora !== 'boolean') return null
  } else if (value.engine === 'anima' || value.engine === 'krea2') {
    if (!record(value.request) || !record(value.context) || typeof value.request.prompt !== 'string'
      || typeof value.request.modelId !== 'string' || !Number.isFinite(value.request.width) || !Number.isFinite(value.request.height)) return null
  } else return null
  return JSON.parse(JSON.stringify(value)) as PreparedBatchImage
}

/** A resumed plan can only look up its original identity and observe the existing task. */
export async function recoverBatchTask(input: BatchDrawRunnerInput): Promise<{ blob: Blob; seed?: number; taskId: string }> {
  const task = await getRuntimeTaskByKey(input.requestKey, input.signal)
  if (!task) throw new Error('原请求接收状态尚未确认；保留请求编号，稍后再核对，不会重新提交。')
  await input.accepted(task.taskId)
  const done = await waitForRuntimeTask(task.taskId, input.signal, value => input.report?.(taskMessage(value)))
  const blob = await fetchRuntimeResult(runtimeResultPath(done), input.signal)
  input.signal.throwIfAborted()
  const seed = Number(done.metadata.seed ?? done.input.seed)
  return { blob, taskId: done.taskId, seed: Number.isFinite(seed) ? seed : undefined }
}

/** Only a definite rejection or runtime-settled failure permits a later new attempt. */
export async function batchFailure(input: BatchDrawRunnerInput, error: unknown, runtimeOwned: boolean): Promise<BatchDrawRunnerResult> {
  const message = error instanceof Error ? error.message : '生成状态暂时无法核对'
  if (!input.reconnect && !input.taskId && error instanceof ApiClientError && error.kind === 'http'
    && error.status >= 400 && error.status < 500) return { ok: false, error: message }
  if (!runtimeOwned) {
    if (error instanceof AcceptedTaskTerminalError && error.taskId === input.taskId) {
      return { ok: false, cancelled: error.status === 'cancelled', error: error.status === 'failed' ? message : undefined }
    }
    return { ok: false, unresolved: true, error: message }
  }
  try {
    const task = await getRuntimeTaskByKey(input.requestKey, input.signal)
    if (task) {
      await input.accepted(task.taskId)
      if (task.upstreamSettled && task.recoveryState !== 'unknown' && task.recoveryState !== 'interrupted') {
        if (task.status === 'cancelled') return { ok: false, cancelled: true }
        if (task.status === 'failed') return { ok: false, error: taskMessage(task) || message }
      }
    }
  } catch { /* Keep the stable request identity while the authority cannot be read. */ }
  return { ok: false, unresolved: true, error: message }
}
