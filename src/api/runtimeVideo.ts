import type { TaskRecord, TaskSummary } from '../../types/tasks'
import type { VideoJob, VideoBatch, VideoBatchShot, CreateVideoBatchInput, VideoDefaults, VideoQuality } from './videoApi'
import { getRuntimeTask, getRuntimeTaskSummary, runtimeResultPath, taskMessage } from './runtimeTasks'
import { assertRuntimeTaskSession } from './runtimeTaskAuthority'

let lastBatch: { id: string; stamp: string; batch: VideoBatch } | undefined
function batchStamp(task: TaskSummary): string {
  // Ownership can change the read-only recovery projection without a durable
  // revision. All other batch fields belong to the persisted revision.
  return JSON.stringify([task.taskId, task.workspaceId, task.principalId, task.runtimeEpoch,
    task.revision, task.recoveryState, task.errorCode, task.upstreamSettled, task.resultState])
}
export async function readRuntimeVideoBatch(id: string, signal?: AbortSignal): Promise<VideoBatch> {
  const previous = lastBatch
  if (previous?.id === id) {
    const summary = await getRuntimeTaskSummary(id, signal)
    signal?.throwIfAborted()
    if (batchStamp(summary) === previous.stamp) return structuredClone(previous.batch)
  }
  const task = await getRuntimeTask(id, signal)
  signal?.throwIfAborted()
  const batch = taskVideoBatch(task)
  // Retain only one small display projection, never the input/checkpoint tree.
  // An overlapping read must not replace a cache another read has published.
  if (lastBatch === previous) lastBatch = { id, stamp: batchStamp(task), batch }
  return structuredClone(batch)
}

const text = (value: unknown) => typeof value === 'string' ? value : ''
const number = (value: unknown, fallback = 0) => typeof value === 'number' && Number.isFinite(value) ? value : fallback
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
export function taskVideoJob(task: TaskRecord): VideoJob {
  const input = task.input, metadata = task.metadata
  const terminal = ['succeeded', 'failed', 'cancelled'].includes(task.status)
  const unknown = task.recoveryState !== 'normal'
  const needsReview = unknown || task.resultState === 'unavailable' || terminal && !task.upstreamSettled
  const elapsed = Math.max(0, Math.floor(((terminal ? task.updatedAt : Date.now()) - task.createdAt) / 1000))
  return { id: task.taskId, status: task.status === 'submitting' ? 'queued' : task.status, provider: task.provider === 'native' ? 'native' : 'comfy',
    progress: task.status === 'succeeded' ? 1 : null, upstreamSettled: task.upstreamSettled, unknown, needsReview, estimatedSeconds: number(metadata.estimatedSeconds), elapsedSeconds: terminal ? Math.max(0, number(metadata.elapsedSeconds, elapsed)) : elapsed,
    modelId: text(input.modelId), prompt: text(input.originalPrompt || input.prompt), width: number(input.width), height: number(input.height), duration: number(input.duration), fps: number(input.fps), seed: number(input.seed),
    createdAt: task.createdAt, resultAvailable: task.resultRefs.some(ref => ref.index === 0),
    resultUrl: task.resultRefs.some(ref => ref.index === 0) ? runtimeResultPath(task) : null,
    error: needsReview || task.status === 'failed' ? taskMessage(task) : null, code: task.errorCode }
}
function videoRetrySource(task: TaskRecord): VideoBatch['retrySource'] {
  const context = record(task.metadata.context)
  // Persisted one-shot retries from older clients retain their original lineage.
  const stepIndices = Array.isArray(context.stepIndices) ? context.stepIndices
    : Number.isSafeInteger(context.stepIndex) && Number(context.stepIndex) >= 0 ? [context.stepIndex] : []
  return typeof context.retriedTaskId === 'string' && context.retriedTaskId && stepIndices.length
    && stepIndices.every(index => Number.isSafeInteger(index) && Number(index) >= 0)
    ? { batchId: context.retriedTaskId, stepIndices: stepIndices.map(Number) } : undefined
}
export function taskVideoBatch(task: TaskRecord): VideoBatch {
  const input = task.input
  const entries = (Array.isArray(task.checkpoint?.shots) ? task.checkpoint.shots : input.shots || []) as unknown[]
  const shots = entries.map((value, position): VideoBatchShot => {
    const item = record(value), shot = record(item.input)
    const result = task.resultRefs.some(ref => ref.index === position)
    return { index: position + 1, status: result ? 'succeeded' : (text(item.status) || 'pending') as VideoBatchShot['status'],
      prompt: text(shot.originalPrompt || shot.prompt), dialogue: text(shot.dialogue) || null,
      shotSize: (text(shot.shotSize) || null) as VideoBatchShot['shotSize'], camera: text(shot.camera) as VideoDefaults['camera'], motion: text(shot.motion) as VideoDefaults['motion'],
      duration: number(shot.duration), seed: number(shot.seed), attempts: number(item.attempts),
      error: item.errorCode ? '镜头需要核对，可在任务中心查看。' : null, code: text(item.errorCode) || null,
      resultAvailable: result, resultUrl: result ? runtimeResultPath(task, position) : null }
  })
  const concatAvailable = task.resultRefs.some(ref => ref.index === shots.length)
  const unknown = task.recoveryState !== 'normal'
  const terminal = ['succeeded', 'failed', 'cancelled'].includes(task.status)
  const needsReview = unknown || task.resultState === 'unavailable' || terminal && !task.upstreamSettled
  return { id: task.taskId, retrySource: videoRetrySource(task), upstreamSettled: task.upstreamSettled, unknown, needsReview, status: task.status === 'succeeded' ? 'done' : task.status === 'cancelled' ? 'cancelled' : task.recoveryState !== 'normal' || task.status === 'failed' ? 'paused' : 'running',
    modelId: text(input.modelId), aspectRatio: text(input.aspectRatio) as VideoBatch['aspectRatio'], quality: text(input.quality) as VideoQuality,
    steps: input.steps === 4 ? 4 : 8, linkLastFrame: input.linkLastFrame === true,
    progress: { total: shots.length, succeeded: shots.filter(shot => shot.status === 'succeeded').length, failed: shots.filter(shot => shot.status === 'failed').length },
    createdAt: task.createdAt, shots, concatAvailable, concatUrl: concatAvailable ? runtimeResultPath(task, shots.length) : null }
}
/** Prepare a selected-shot retry without admitting work; its caller saves a fresh request first. */
export async function prepareRuntimeVideoRetry(id: string, indices: number[], signal?: AbortSignal): Promise<{ input: Record<string, unknown>; context: Record<string, unknown> }> {
  const task = await getRuntimeTask(id, signal)
  signal?.throwIfAborted()
  assertRuntimeTaskSession(task)
  if (task.kind !== 'batch' || !task.upstreamSettled || task.recoveryState !== 'normal')
    throw new Error('原分镜尚未确认结束，请先在任务中心核对。')
  const entries = task.checkpoint?.shots as Array<{ input: Record<string, unknown>; status: string }> | undefined
  if (!indices.length || new Set(indices).size !== indices.length || indices.some(index => !Number.isSafeInteger(index) || index < 1 || !entries?.[index - 1]))
    throw new Error('重抽镜头编号无效，请重新读取原分镜。')
  const shots = indices.map(index => {
    const source = entries![index - 1]
    if (!['failed', 'cancelled'].includes(source.status)) throw new Error('仅能重新生成已确认失败或取消的镜头。')
    const input = source.input
    return { prompt: text(input.originalPrompt || input.prompt), seed: number(input.seed), duration: number(input.duration) as VideoDefaults['duration'],
      camera: text(input.camera) as VideoDefaults['camera'], motion: text(input.motion) as VideoDefaults['motion'],
      ...(input.dialogue ? { dialogue: text(input.dialogue) } : {}), ...(input.shotSize ? { shotSize: input.shotSize as VideoBatchShot['shotSize'] } : {}),
      ...(input.image ? { image: text(input.image) } : {}), ...(Array.isArray(input.references) ? { references: [...input.references] as string[] } : {}) }
  })
  const input = { modelId: text(task.input.modelId), aspectRatio: task.input.aspectRatio, quality: task.input.quality,
    steps: task.input.steps, linkLastFrame: false, shots } as CreateVideoBatchInput
  return { input: input as unknown as Record<string, unknown>, context: { retriedTaskId: id, stepIndices: indices.map(index => index - 1) } }
}
