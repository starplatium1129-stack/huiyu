import { apiClient } from './client'
import { fetchResultImage, jobPath, waitForDirectImageJob } from './directImageJobs'
import { acceptDirectImageRequest, cancelDirectImageRequest } from './directImageRequests'
import { cancelRuntimeTaskKey, fetchRuntimeResult, getRuntimeTaskByKey, hasRuntimeTasks, runtimeResultPath, submitRuntimeTask, taskMessage, waitForRuntimeTask } from './runtimeTasks'
import { imageMediaSession } from '@/platform/imageMediaSession'
import { runtimeResourceIdentity } from '@/platform/runtimeUrl'

export interface KeyframeModel {
  id: string
  label: string
  available: boolean
  reason?: string
  maxReferences: number
  minSize: number
  maxSize: number
  alignment: number
  defaultSteps?: number
}

export async function listKeyframeModels(signal?: AbortSignal): Promise<KeyframeModel[]> {
  const status = await apiClient.request<Record<string, unknown>>('/api/keyframe/status', { signal, timeoutMs: 30_000, cachePolicy: 'bypass' })
  if (status.ok !== true || status.provider !== 'native' || !Array.isArray(status.models)) throw new Error('原生关键帧模型状态暂不可用')
  return status.models.map(model => {
    const limits = model?.capabilities
    if (model?.family !== 'keyframe' || typeof model.id !== 'string' || typeof model.label !== 'string' || typeof model.available !== 'boolean'
      || ![limits?.maxReferenceImages, limits?.minSize, limits?.maxSize, limits?.alignment].every(v => Number.isSafeInteger(v) && v > 0)) throw new Error('关键帧模型清单无效，请核对后端版本')
    return { id: model.id, label: model.label, available: model.available, reason: model.unavailableReason || undefined,
      maxReferences: limits.maxReferenceImages, minSize: limits.minSize, maxSize: limits.maxSize, alignment: limits.alignment,
      defaultSteps: Number.isSafeInteger(model.defaults?.steps) ? model.defaults.steps : undefined }
  })
}

interface KeyframeRequest {
  modelId: string
  prompt: string
  seed: number
  width: number
  height: number
  steps?: number
  images: Blob[]
  requestKey: string
  resume?: boolean
  beforeSubmit?: () => Promise<void>
}

export async function generateKeyframe(request: KeyframeRequest, signal: AbortSignal, onProgress?: (message: string) => void): Promise<{ blob: Blob; taskId: string }> {
  const session = imageMediaSession(), desktop = hasRuntimeTasks()
  const checkSession = () => {
    signal.throwIfAborted()
    if (session !== imageMediaSession()) throw new Error('工作区连接已更换，请回到原项目继续取图')
  }
  const { requestKey, modelId, seed, width, height, prompt } = request
  const input: Record<string, unknown> = { modelId, seed, width, height, prompt }
  if (request.steps !== undefined) input.steps = request.steps
  checkSession()
  if (!request.resume) {
    if (request.images.length < 1 || request.images.length > 4) throw new Error('请选择 1 至 4 张参考图')
    const names: string[] = []
    for (const blob of request.images) {
      if (!blob.size || blob.size > 16 * 1024 * 1024 || !['image/png', 'image/jpeg', 'image/webp'].includes(blob.type)) throw new Error('参考图支持 16 MiB 以内的 PNG、JPEG 或 WebP')
      onProgress?.(`正在准备参考图 ${names.length + 1} / ${request.images.length}`)
      const upload = await apiClient.request<{ok: boolean; name: string}>('/api/keyframe/images/raw', {
        method: 'POST', body: blob, headers: { 'Content-Type': 'application/octet-stream' }, signal, timeoutMs: 60_000,
        validate: value => value.ok === true && typeof value.name === 'string' && !!value.name,
      })
      checkSession()
      names.push(upload.name)
    }
    input.initImage = names[0]
    input.referenceImages = names.slice(1)
    await request.beforeSubmit?.()
    checkSession()
  }
  const timeoutMs = 40 * 60_000
  if (desktop) {
    const accepted = request.resume ? await getRuntimeTaskByKey(requestKey, signal) : await submitRuntimeTask('keyframe', input, requestKey, {}, { signal })
    checkSession()
    if (!accepted) throw new Error('尚未查到这个请求的回执，可以稍后继续查询')
    if (accepted.kind !== 'keyframe' || accepted.provider !== 'native' || accepted.input.modelId !== modelId || accepted.input.seed !== seed) throw new Error('任务与候选图的模型或种子不一致')
    const finished = await waitForRuntimeTask(accepted.taskId, signal, task => onProgress?.(task.liveProgress?.message || taskMessage(task)), { timeoutMs })
    checkSession()
    const blob = await fetchRuntimeResult(runtimeResultPath(finished), signal, finished)
    checkSession()
    return { blob, taskId: finished.taskId }
  }
  const accepted = await acceptDirectImageRequest('keyframe', input, requestKey, { signal, resume: request.resume })
  checkSession()
  const job = await waitForDirectImageJob('keyframe', accepted.id, signal, { timeoutMs, immediate: true, update: job => onProgress?.(job.progressText || '正在生成关键帧') })
  checkSession()
  if (job.seed !== seed || job.provider !== 'native') throw new Error('关键帧任务的来源或种子不一致')
  const blob = await fetchResultImage(`${jobPath('keyframe', job.id)}/result`, signal)
  checkSession()
  return { blob, taskId: job.id }
}

export async function cancelKeyframe(requestKey: string, signal?: AbortSignal): Promise<void> {
  const job = hasRuntimeTasks() ? await cancelRuntimeTaskKey(requestKey, signal)
    : await cancelDirectImageRequest('keyframe', requestKey, runtimeResourceIdentity(), undefined, signal)
  if (!job) return // The persisted cancellation intent covers even a late submission.
  if (job.status === 'succeeded') throw new Error('这张候选图已经生成，请继续取回原图')
  if (job.upstreamSettled !== true || !['cancelled', 'failed'].includes(job.status)) throw new Error('已请求取消，请稍后核对原任务状态')
}
