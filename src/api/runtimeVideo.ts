import type { TaskRecord } from '../../types/tasks'
import type { VideoJob, VideoBatch, VideoBatchShot, CreateVideoBatchInput, VideoDefaults, VideoQuality } from './videoApi'
import { getRuntimeTask, runtimeResultPath, submitRuntimeTask, taskMessage } from './runtimeTasks'

const text = (value: unknown) => typeof value === 'string' ? value : ''
const number = (value: unknown, fallback = 0) => typeof value === 'number' && Number.isFinite(value) ? value : fallback
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {}
export function taskVideoJob(task: TaskRecord): VideoJob {
  const input = task.input, metadata = task.metadata
  return { id: task.taskId, status: task.status === 'submitting' ? 'queued' : task.status, provider: 'comfy',
    progress: task.status === 'succeeded' ? 1 : 0, estimatedSeconds: number(metadata.estimatedSeconds), elapsedSeconds: Math.max(0, Math.floor((Date.now() - task.createdAt) / 1000)),
    modelId: text(input.modelId), prompt: text(input.originalPrompt || input.prompt), width: number(input.width), height: number(input.height), duration: number(input.duration), fps: number(input.fps), seed: number(input.seed),
    createdAt: task.createdAt, resultAvailable: task.resultRefs.some(ref => ref.index === 0),
    resultUrl: task.resultRefs.some(ref => ref.index === 0) ? runtimeResultPath(task) : null,
    error: task.recoveryState !== 'normal' || task.status === 'failed' ? taskMessage(task) : null, code: task.errorCode }
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
  return { id: task.taskId, status: task.status === 'succeeded' ? 'done' : task.status === 'cancelled' ? 'cancelled' : task.recoveryState !== 'normal' || task.status === 'failed' ? 'paused' : 'running',
    modelId: text(input.modelId), aspectRatio: text(input.aspectRatio) as VideoBatch['aspectRatio'], quality: text(input.quality) as VideoQuality,
    steps: input.steps === 4 ? 4 : 8, linkLastFrame: input.linkLastFrame === true,
    progress: { total: shots.length, succeeded: shots.filter(shot => shot.status === 'succeeded').length, failed: shots.filter(shot => shot.status === 'failed').length },
    createdAt: task.createdAt, shots, concatAvailable, concatUrl: concatAvailable ? runtimeResultPath(task, shots.length) : null }
}
/** A user retry is a new one-shot batch; the original batch and its results stay in the inbox. */
export async function retryRuntimeVideoShot(id: string, index: number) {
  const task = await getRuntimeTask(id)
  if (!task.upstreamSettled) throw new Error('原分镜尚未确认结束，请先在任务中心核对。')
  const entries = task.checkpoint?.shots as Array<{ input: Record<string, unknown>; status: string }> | undefined
  const source = entries?.[index - 1]
  if (!source || !['failed', 'cancelled'].includes(source.status)) throw new Error('仅能重新生成已确认失败或取消的镜头。')
  const input = source.input
  const shot = { prompt: text(input.originalPrompt || input.prompt), seed: number(input.seed), duration: number(input.duration) as VideoDefaults['duration'],
    camera: text(input.camera) as VideoDefaults['camera'], motion: text(input.motion) as VideoDefaults['motion'],
    ...(input.dialogue ? { dialogue: text(input.dialogue) } : {}), ...(input.shotSize ? { shotSize: input.shotSize as VideoBatchShot['shotSize'] } : {}),
    ...(input.image ? { image: text(input.image) } : {}), ...(Array.isArray(input.references) ? { references: input.references as string[] } : {}) }
  const next = { modelId: text(task.input.modelId), aspectRatio: task.input.aspectRatio, quality: task.input.quality,
    steps: task.input.steps, adultEnabled: task.input.adultEnabled, linkLastFrame: false, shots: [shot] } as CreateVideoBatchInput
  return taskVideoBatch(await submitRuntimeTask('batch', next as unknown as Record<string, unknown>, crypto.randomUUID(), { retriedTaskId: id, stepIndex: index - 1 }))
}
