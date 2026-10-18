import { AcceptedTaskTerminalError } from '@/api/acceptedTaskOutcome'
import { DirectRequestRejected } from '@/api/directGenerationRequests'
import { getRuntimeTaskByKey, waitForRuntimeTask, taskMessage } from '@/api/runtimeTasks'
import type { AnimaRequest } from '../generation/useAnimaSession'
import type { SDQueueJob } from '../generation/useSDQueue'
import type { BatchDrawRunnerInput, BatchDrawRunnerResult } from '../generation/useBatchDraw'
import type { usePromptBuilderStore } from '@/stores/promptBuilderStore'
import type { AnimaJobMetadata } from '@/types/anima'

type HistoryInput = Parameters<ReturnType<typeof usePromptBuilderStore>['commitHistoryEntry']>[0]
type HistorySnapshot = Omit<HistoryInput, 'blob'>
export type PreparedBatchImage = { adult: boolean; history: HistorySnapshot } & (
  { engine: 'sd'; job: Omit<SDQueueJob, 'id'>; disableLora: boolean }
  | { engine: 'anima' | 'krea2'; request: AnimaRequest; context: Record<string, unknown> }
)
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** Direct jobs supply their own recipe; creative fields remain in the prepared plan. */
export function batchHistoryFromMetadata(plan: Exclude<PreparedBatchImage, { engine: 'sd' }>, metadata: AnimaJobMetadata): HistorySnapshot {
  return {
    ...plan.history,
    engine: metadata.engine, provider: metadata.provider,
    prompt: metadata.prompt, negative: metadata.negative, seed: metadata.seed,
    profile: metadata.profileId, model: metadata.modelId,
    lora: metadata.loraId, loraId: metadata.loraId, loraStrength: metadata.loraStrength,
    loras: metadata.loras?.map(lora => ({ ...lora })), noLora: !metadata.loraId,
    styleLoraId: metadata.styleLoraId ?? null, preview: metadata.preview === true,
    cfg: metadata.cfg, steps: metadata.steps, sampler: metadata.sampler, scheduler: metadata.scheduler,
    size: `${metadata.width}x${metadata.height}`,
    hiresFix: metadata.hiresFix ?? Boolean(plan.request.hiresFix),
    hiresScale: metadata.hiresScale ?? plan.request.hiresScale,
    hiresDenoise: metadata.hiresDenoise ?? plan.request.hiresDenoise,
    hiresUpscaler: metadata.hiresUpscaler !== undefined ? metadata.hiresUpscaler ?? '' : plan.request.hiresUpscaler,
    hiresSteps: metadata.hiresSteps, faceDetailer: metadata.faceDetailer ?? false,
  }
}

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
export async function recoverBatchTask(input: BatchDrawRunnerInput): Promise<{ taskId: string }> {
  const task = await getRuntimeTaskByKey(input.requestKey, input.signal)
  if (!task) throw new Error('原请求接收状态尚未确认；保留请求编号，稍后再核对，不会重新提交。')
  await input.accepted(task.taskId)
  const done = await waitForRuntimeTask(task.taskId, input.signal, value => input.report?.(taskMessage(value)))
  input.signal.throwIfAborted()
  return { taskId: done.taskId }
}

/** Only a definite rejection or runtime-settled failure permits a later new attempt. */
export async function batchFailure(input: BatchDrawRunnerInput, error: unknown, runtimeOwned: boolean): Promise<BatchDrawRunnerResult> {
  const message = error instanceof Error ? error.message : '生成状态暂时无法核对'
  if (error instanceof DirectRequestRejected) return { ok: false, cancelled: error.code === 'IMAGE_REQUEST_CANCELLED', error: message }
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
