import { apiClient } from './client'
import { isRuntimeTaskId, getRuntimeTask, cancelRuntimeTask, actOnRuntimeTask } from './runtimeTasks'
import { taskVideoJob, taskVideoBatch, readRuntimeVideoBatch } from './runtimeVideo'
import {
  videoBatchResponse,
  videoJobResponse,
  isVideoStatusResponse,
  isVideoStoryboard,
} from './videoApiResponse'

export type VideoMode = 'text' | 'image' | 'first-last-frame'
export type VideoJobStatus = 'queued' | 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled'
export type VideoQuality = 'fast' | 'standard' | 'fine'

export interface VideoQualityOption {
  id: VideoQuality
  label: string
  summary: string
  sizes: Record<string, string>
}

export interface VideoModelStatus {
  id: string
  label: string
  family: string
  tier: string
  summary: string
  executable: boolean
  available: boolean
  reason: string
  modes: VideoMode[]
  requirements: string[]
  missing: string[]
}

export interface VideoDefaults {
  modelId: string
  aspectRatio: 'landscape' | 'portrait' | 'square' | 'original'
  /** H3 额外支持 10s/15s 长镜（训练区间 124–362 帧，16GB 真机已验证）。 */
  duration: 3 | 5 | 10 | 15
  camera: 'still' | 'push' | 'pull' | 'pan' | 'orbit'
  motion: 'subtle' | 'natural' | 'expressive'
  quality: VideoQuality
}

export interface VideoStatusResponse {
  ok: true
  online: boolean
  pending: number
  maxPending: number
  models: VideoModelStatus[]
  qualities: VideoQualityOption[]
  defaults: VideoDefaults
  /** T8 双时钟加速路径状态（降级时前端应展示提示）。 */
  t8: {
    available: boolean
    reason: string
  }
}

export interface VideoJob {
  id: string
  status: VideoJobStatus
  provider: 'comfy' | 'native'
  progress: number | null
  upstreamSettled: boolean
  unknown: boolean
  /** Recovery requires checking the original task rather than fresh generation. */
  needsReview?: boolean
  /** 预估总时长（秒）；0 表示尚无实测估算。 */
  estimatedSeconds: number
  /** 已运行秒数，仅用于展示耗时。 */
  elapsedSeconds: number
  modelId: string
  prompt: string
  width: number
  height: number
  duration: number
  fps: number
  seed: number
  createdAt: number
  resultAvailable: boolean
  resultUrl: string | null
  error: string | null
  code: string | null
}

export interface VideoJobResponse {
  ok: true
  job: VideoJob
}

export interface VideoImageUploadResponse {
  ok: true
  name: string
  bytes: number
}


export function fetchVideoStatus(signal?: AbortSignal): Promise<VideoStatusResponse> {
  return apiClient.request<VideoStatusResponse>('/api/video/status', {
    cache: 'no-store',
    signal,
    timeoutMs: 8_000,
    validate: isVideoStatusResponse,
  })
}

/** 首帧/尾帧/参考图经 runtime 校验写入受控输入目录；kind:'reference' 使用独立前缀。
 * 同一 owner 的相同内容可复用受控名。草稿恢复依据耐久原图，而非此上传回执。 */
export function uploadVideoImage(data: Blob, kind?: 'reference', signal?: AbortSignal): Promise<VideoImageUploadResponse> {
  return apiClient.request<VideoImageUploadResponse>(`/api/video/images/raw${kind ? '?kind=reference' : ''}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: data,
    signal,
    timeoutMs: 60_000,
    validate: (value: Record<string, unknown>) =>
      value.ok === true && typeof value.name === 'string' && typeof value.bytes === 'number',
  })
}

/** Reuse an owned durable task result without sending its image bytes back. */
export function importVideoImage(taskId: string, alias: string, index = 0, signal?: AbortSignal): Promise<VideoImageUploadResponse> {
  return importVideoMedia({ taskId, alias, index }, signal)
}

/** Import an already-authorized workspace alias; failures must not fall back to uploading. */
export function importWorkspaceVideoImage(alias: string, signal?: AbortSignal): Promise<VideoImageUploadResponse> {
  return importVideoMedia({ source: 'workspace', alias }, signal)
}

function importVideoMedia(body: { taskId: string; alias: string; index: number } | { source: 'workspace'; alias: string }, signal?: AbortSignal): Promise<VideoImageUploadResponse> {
  return apiClient.request<VideoImageUploadResponse>('/api/workspace/video-images', {
    method: 'POST',
    body,
    signal,
    timeoutMs: 60_000,
    validate: (value: Record<string, unknown>) =>
      value.ok === true && typeof value.name === 'string' && typeof value.bytes === 'number',
  })
}

export function fetchVideoJob(id: string, signal?: AbortSignal): Promise<VideoJobResponse> {
  if (isRuntimeTaskId(id)) return getRuntimeTask(id, signal).then(task => ({ ok: true, job: taskVideoJob(task) }))
  return apiClient.request<VideoJobResponse>(`/api/video/jobs/${encodeURIComponent(id)}`, {
    cache: 'no-store',
    signal,
    timeoutMs: 12_000,
  }).then(value => videoJobResponse(value, id))
}

export function cancelVideoJob(id: string, signal?: AbortSignal): Promise<VideoJobResponse> {
  if (isRuntimeTaskId(id)) return cancelRuntimeTask(id, signal).then(task => { if (!task) throw new Error('任务尚未找到'); return { ok: true, job: taskVideoJob(task) } })
  return apiClient.request<VideoJobResponse>(`/api/video/jobs/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    signal,
    timeoutMs: 15_000,
  }).then(value => videoJobResponse(value, id))
}

// ── 分镜批量（P5 批量生成 / P6 尾帧衔接 / P8 拼接成片）──────────────────────
export type VideoShotStatus = 'pending' | 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
export type VideoBatchStatus = 'running' | 'paused' | 'done' | 'cancelled'
export type VideoShotSize = 'wide' | 'medium' | 'closeup'

export interface VideoBatchShot {
  index: number
  status: VideoShotStatus
  prompt: string
  dialogue: string | null
  shotSize: VideoShotSize | null
  camera: VideoDefaults['camera']
  motion: VideoDefaults['motion']
  duration: number
  seed: number
  attempts: number
  error: string | null
  code: string | null
  resultAvailable: boolean
  resultUrl: string | null
}

export interface VideoBatch {
  /** A selected-shot retry stays independent of source results and concatenation. */
  retrySource?: { batchId: string; stepIndices: number[] }
  upstreamSettled: boolean
  unknown: boolean
  needsReview?: boolean
  id: string
  status: VideoBatchStatus
  modelId: string
  aspectRatio: 'landscape' | 'portrait' | 'square'
  quality: VideoQuality
  steps: 4 | 8
  linkLastFrame: boolean
  progress: { total: number; succeeded: number; failed: number }
  createdAt: number
  shots: VideoBatchShot[]
  concatAvailable: boolean
  concatUrl: string | null
}

export interface CreateVideoBatchShotInput {
  prompt: string
  dialogue?: string
  shotSize?: VideoShotSize
  camera?: VideoDefaults['camera']
  motion?: VideoDefaults['motion']
  /** 分镜时长，缺省 5 秒（H3 训练区间下限，剧情片推荐档）。 */
  duration?: VideoDefaults['duration']
  seed?: number
  /** 首帧图：POST /api/video/images/raw 返回的受控文件名。 */
  image?: string
  /** 参考图（Ref2VA 角色卡）：受控文件名数组，≤9 张，仅 H3；prompt 用 <Picture N> 引用。 */
  references?: string[]
}

export interface CreateVideoBatchInput {
  modelId: string
  /** 整批统一画幅：拼接成片要求分辨率一致。 */
  aspectRatio: 'landscape' | 'portrait' | 'square'
  quality?: VideoQuality
  /** 采样步数（H3 专属）：8 标准（默认）/ 4 极速（约快一倍，质量略降）。 */
  steps?: 4 | 8
  /** 自动用上一镜尾帧衔接下一镜（FL2VA / I2VA 续接），默认开启。 */
  linkLastFrame?: boolean
  shots: CreateVideoBatchShotInput[]
}

/** 场景蓝图一键剧本（2026-08-23）：服务端确定性四镜（起承转合）派生结果。 */
export interface VideoStoryboardShot {
  prompt: string
  dialogue: string | null
  shotSize: VideoShotSize
  camera: VideoDefaults['camera']
  motion: VideoDefaults['motion']
  duration: number
  /** 首帧出图提示词（蓝图英文散文 + 镜头构图句）；蓝图无散文素材时为 null。 */
  firstFramePrompt: string | null
}

export interface VideoStoryboard {
  title: string
  blueprintId: string
  characterId: string
  beats: string[]
  shots: VideoStoryboardShot[]
}

export function createVideoStoryboard(
  blueprintId: string,
  intent?: string,
  signal?: AbortSignal,
): Promise<{ ok: true; storyboard: VideoStoryboard }> {
  return apiClient.request<{ ok: true; storyboard: VideoStoryboard }>('/api/video/storyboard', {
    method: 'POST',
    body: intent ? { blueprintId, intent } : { blueprintId },
    signal,
    timeoutMs: 15_000,
    validate: (value: Record<string, unknown>) => value.ok === true && isVideoStoryboard(value.storyboard),
  })
}

export interface VideoBatchResponse {
  ok: true
  batch: VideoBatch
}


export function fetchVideoBatch(id: string, signal?: AbortSignal): Promise<VideoBatchResponse> {
  if (isRuntimeTaskId(id)) return readRuntimeVideoBatch(id, signal).then(batch => ({ ok: true, batch }))
  return apiClient.request<VideoBatchResponse>(`/api/video/batches/${encodeURIComponent(id)}`, {
    cache: 'no-store',
    signal,
    timeoutMs: 12_000,
  }).then(value => videoBatchResponse(value, id))
}

export function cancelVideoBatch(id: string, signal?: AbortSignal): Promise<VideoBatchResponse> {
  if (isRuntimeTaskId(id)) return cancelRuntimeTask(id, signal).then(task => { if (!task) throw new Error('任务尚未找到'); return { ok: true, batch: taskVideoBatch(task) } })
  return apiClient.request<VideoBatchResponse>(`/api/video/batches/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    signal,
    timeoutMs: 15_000,
  }).then(value => videoBatchResponse(value, id))
}

export function concatVideoBatch(id: string, signal?: AbortSignal): Promise<VideoBatchResponse> {
  if (isRuntimeTaskId(id)) return actOnRuntimeTask(id, 'concat', signal).then(task => ({ ok: true, batch: taskVideoBatch(task) }))
  return apiClient.request<VideoBatchResponse>(
    `/api/video/batches/${encodeURIComponent(id)}/concat`,
    {
      method: 'POST',
      signal,
      timeoutMs: 60_000,
    },
  ).then(value => videoBatchResponse(value, id))
}
