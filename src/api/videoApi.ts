import { apiClient } from './client'
import { hasRuntimeTasks, isRuntimeTaskId, submitRuntimeTask, getRuntimeTask, cancelRuntimeTask, actOnRuntimeTask } from './runtimeTasks'
import { taskVideoJob, taskVideoBatch, retryRuntimeVideoShot } from './runtimeVideo'
import {
  isVideoBatchResponse,
  isVideoJobResponse,
  isVideoStatusResponse,
  isVideoStoryboard,
} from './videoApiResponse'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

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
  provider: 'comfy'
  progress: number
  /** 预估总时长（秒）：帧数×步数×速率 + 加载余量（服务端校准）。 */
  estimatedSeconds: number
  /** 已运行秒数（时间外推进度用）。 */
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

export interface CreateVideoJobInput {
  prompt: string
  negative?: string
  modelId: string
  aspectRatio: VideoDefaults['aspectRatio']
  duration: VideoDefaults['duration']
  camera: VideoDefaults['camera']
  motion: VideoDefaults['motion']
  seed?: number
  /** 首帧图：POST /api/video/images 返回的受控文件名（I2VA/FL2VA 模式）。 */
  image?: string
  /** 尾帧图：POST /api/video/images 返回的受控文件名（FL2VA/L2VA 模式，H3 专属）。 */
  lastFrame?: string
  /** 画质档位：fast 0.2MP / standard 0.4MP（默认）/ fine 0.5MP。 */
  quality?: VideoQuality
  /** 采样步数（H3 专属）：8 标准（默认）/ 4 极速（约快一倍，质量略降）。 */
  steps?: 4 | 8
  /** 成人内容传输层授权信号：本机直连默认 true（与出图侧同源），远程/隧道由服务端 fail-closed。 */
  adultEnabled?: boolean
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

export function createVideoJob(input: CreateVideoJobInput, signal?: AbortSignal): Promise<VideoJobResponse> {
  if (hasRuntimeTasks()) return submitRuntimeTask('video', input as unknown as Record<string, unknown>).then(task => ({ ok: true, job: taskVideoJob(task) }))
  return apiClient.request<VideoJobResponse>('/api/video/jobs', {
    method: 'POST',
    body: input,
    signal,
    timeoutMs: 30_000,
    validate: isVideoJobResponse,
  })
}

/** 首帧图/尾帧图/参考图上传：base64 图片数据 → 网关校验后写入 ComfyUI/input，返回受控文件名。
 *  kind:'reference' 用独立前缀（跨任务资产，网关重启不清理）；首帧/尾帧走缺省前缀（任务级清理）。
 *  同一端点即覆盖 FL2VA 尾帧通道（后端按 IMAGE_INPUT_PATTERN 白名单校验）。 */
export function uploadVideoImage(data: string, kind?: 'reference', signal?: AbortSignal): Promise<VideoImageUploadResponse> {
  return apiClient.request<VideoImageUploadResponse>('/api/video/images', {
    method: 'POST',
    body: kind ? { data, kind } : { data },
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
    validate: isVideoJobResponse,
  })
}

export function cancelVideoJob(id: string, signal?: AbortSignal): Promise<VideoJobResponse> {
  if (isRuntimeTaskId(id)) return cancelRuntimeTask(id).then(task => { if (!task) throw new Error('任务尚未找到'); return { ok: true, job: taskVideoJob(task) } })
  return apiClient.request<VideoJobResponse>(`/api/video/jobs/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    signal,
    timeoutMs: 15_000,
    validate: isVideoJobResponse,
  })
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
  /** 首帧图：POST /api/video/images 返回的受控文件名。 */
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
  /** 成人内容传输层授权信号：本机直连默认 true（与出图侧同源），远程/隧道由服务端 fail-closed。 */
  adultEnabled?: boolean
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


export function createVideoBatch(input: CreateVideoBatchInput, signal?: AbortSignal): Promise<VideoBatchResponse> {
  if (hasRuntimeTasks()) return submitRuntimeTask('batch', input as unknown as Record<string, unknown>).then(task => ({ ok: true, batch: taskVideoBatch(task) }))
  return apiClient.request<VideoBatchResponse>('/api/video/batches', {
    method: 'POST',
    body: input,
    signal,
    timeoutMs: 30_000,
    validate: isVideoBatchResponse,
  })
}

export function fetchVideoBatch(id: string, signal?: AbortSignal): Promise<VideoBatchResponse> {
  if (isRuntimeTaskId(id)) return getRuntimeTask(id, signal).then(task => ({ ok: true, batch: taskVideoBatch(task) }))
  return apiClient.request<VideoBatchResponse>(`/api/video/batches/${encodeURIComponent(id)}`, {
    cache: 'no-store',
    signal,
    timeoutMs: 12_000,
    validate: isVideoBatchResponse,
  })
}

export function cancelVideoBatch(id: string, signal?: AbortSignal): Promise<VideoBatchResponse> {
  if (isRuntimeTaskId(id)) return cancelRuntimeTask(id).then(task => { if (!task) throw new Error('任务尚未找到'); return { ok: true, batch: taskVideoBatch(task) } })
  return apiClient.request<VideoBatchResponse>(`/api/video/batches/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    signal,
    timeoutMs: 15_000,
    validate: isVideoBatchResponse,
  })
}

export function retryVideoShot(id: string, index: number, signal?: AbortSignal): Promise<VideoBatchResponse> {
  if (isRuntimeTaskId(id)) return retryRuntimeVideoShot(id, index).then(batch => ({ ok: true, batch }))
  return apiClient.request<VideoBatchResponse>(
    `/api/video/batches/${encodeURIComponent(id)}/shots/${index}/retry`,
    {
      method: 'POST',
      signal,
      timeoutMs: 15_000,
      validate: isVideoBatchResponse,
    },
  )
}

export function concatVideoBatch(id: string, signal?: AbortSignal): Promise<VideoBatchResponse> {
  if (isRuntimeTaskId(id)) return actOnRuntimeTask(id, 'concat').then(task => ({ ok: true, batch: taskVideoBatch(task) }))
  return apiClient.request<VideoBatchResponse>(
    `/api/video/batches/${encodeURIComponent(id)}/concat`,
    {
      method: 'POST',
      signal,
      timeoutMs: 60_000,
      validate: isVideoBatchResponse,
    },
  )
}

// ── 分镜「AI 整理」（POST /api/video-ai/rewrite，复用聊天 LLM 配置）────────
export interface VideoAiStatusResponse {
  ok: true
  available: boolean
  source: 'api' | 'ollama' | null
  model: string
  label: string
  reason?: string
}

export interface VideoAiRewriteInput {
  /** 角色锚点（仅作身份参考，LLM 不在描述里重复它）。 */
  identity?: string
  prompt: string
  shotSize?: VideoShotSize | null
  camera?: VideoDefaults['camera']
  motion?: VideoDefaults['motion']
  dialogue?: string
}

export interface VideoAiRewriteResponse {
  ok: true
  source: 'api' | 'ollama'
  model: string
  shot: {
    prompt: string
    shotSize: VideoShotSize | null
    camera: VideoDefaults['camera']
    motion: VideoDefaults['motion']
    dialogue: string
  }
}

function isVideoAiStatusResponse(value: Record<string, unknown>): boolean {
  return value.ok === true && typeof value.available === 'boolean'
}

function isVideoAiRewriteResponse(value: Record<string, unknown>): boolean {
  return value.ok === true
    && (value.source === 'api' || value.source === 'ollama')
    && typeof value.model === 'string'
    && isRecord(value.shot)
    && typeof value.shot.prompt === 'string'
}

export function fetchVideoAiStatus(signal?: AbortSignal): Promise<VideoAiStatusResponse> {
  return apiClient.request<VideoAiStatusResponse>('/api/video-ai/status', {
    cache: 'no-store',
    signal,
    timeoutMs: 8_000,
    validate: isVideoAiStatusResponse,
  })
}

export function rewriteVideoShot(input: VideoAiRewriteInput, signal?: AbortSignal): Promise<VideoAiRewriteResponse> {
  return apiClient.request<VideoAiRewriteResponse>('/api/video-ai/rewrite', {
    method: 'POST',
    body: input,
    signal,
    timeoutMs: 150_000,
    validate: isVideoAiRewriteResponse,
  })
}

// ── 整批节奏编排（POST /api/video-ai/polish）───────────────────────────
export interface VideoAiPolishShotInput {
  prompt: string
  shotSize?: VideoShotSize | null
  camera?: VideoDefaults['camera']
  motion?: VideoDefaults['motion']
  dialogue?: string
}

export interface VideoAiPolishInput {
  identity?: string
  shots: VideoAiPolishShotInput[]
}

export interface VideoAiPolishShot {
  /** null = 保持当前值（AI 认为不需要动）。 */
  shotSize: VideoShotSize | null
  camera: VideoDefaults['camera'] | null
  motion: VideoDefaults['motion'] | null
  dialogue: string | null
}

export interface VideoAiPolishResponse {
  ok: true
  source: 'api' | 'ollama'
  model: string
  shots: VideoAiPolishShot[]
}

function isVideoAiPolishResponse(value: Record<string, unknown>): boolean {
  return value.ok === true
    && (value.source === 'api' || value.source === 'ollama')
    && Array.isArray(value.shots)
}

export function polishVideoShots(input: VideoAiPolishInput, signal?: AbortSignal): Promise<VideoAiPolishResponse> {
  return apiClient.request<VideoAiPolishResponse>('/api/video-ai/polish', {
    method: 'POST',
    body: input,
    signal,
    timeoutMs: 150_000,
    validate: isVideoAiPolishResponse,
  })
}

// ── 台词润色（POST /api/video-ai/dialogue）──────────────────────────────
export interface VideoAiDialogueInput {
  identity?: string
  prompt: string
  currentDialogue?: string
  mood?: string
}

export interface VideoAiDialogueOption {
  text: string
  label: string
}

export interface VideoAiDialogueResponse {
  ok: true
  source: 'api' | 'ollama'
  model: string
  options: VideoAiDialogueOption[]
}

export function suggestDialogue(input: VideoAiDialogueInput, signal?: AbortSignal): Promise<VideoAiDialogueResponse> {
  return apiClient.request<VideoAiDialogueResponse>('/api/video-ai/dialogue', {
    method: 'POST',
    body: input,
    signal,
    timeoutMs: 150_000,
    validate: (value: Record<string, unknown>) =>
      value.ok === true && Array.isArray(value.options),
  })
}

// ── 分镜质量检查（POST /api/video-ai/review）────────────────────────────
export interface VideoAiReviewShotInput {
  prompt: string
  shotSize?: VideoShotSize | null
  camera?: VideoDefaults['camera']
  motion?: VideoDefaults['motion']
  dialogue?: string
}

export interface VideoAiIssue {
  index: number
  severity: 'error' | 'warn'
  field: string
  message: string
  suggestion: string
}

export interface VideoAiReviewResponse {
  ok: true
  source: 'api' | 'ollama'
  model: string
  issues: VideoAiIssue[]
}

export function reviewVideoShots(shots: VideoAiReviewShotInput[], signal?: AbortSignal): Promise<VideoAiReviewResponse> {
  return apiClient.request<VideoAiReviewResponse>('/api/video-ai/review', {
    method: 'POST',
    body: { shots },
    signal,
    timeoutMs: 150_000,
    validate: (value: Record<string, unknown>) =>
      value.ok === true && Array.isArray(value.issues),
  })
}

// ── 全自动分镜脚本（POST /api/video-ai/script）──────────────────────────
export interface VideoAiScriptInput {
  identity?: string
  story: string
  shotCount?: number
  totalSeconds?: number
  characterLabels?: string[]
}

export interface VideoAiScriptShot {
  prompt: string
  shotSize: VideoShotSize | null
  camera: VideoDefaults['camera']
  motion: VideoDefaults['motion']
  dialogue: string
  duration: VideoDefaults['duration']
}

export interface VideoAiScriptResponse {
  ok: true
  source: 'api' | 'ollama'
  model: string
  shots: VideoAiScriptShot[]
}

export function generateVideoScript(input: VideoAiScriptInput, signal?: AbortSignal): Promise<VideoAiScriptResponse> {
  return apiClient.request<VideoAiScriptResponse>('/api/video-ai/script', {
    method: 'POST',
    body: input,
    signal,
    timeoutMs: 180_000,
    validate: (value: Record<string, unknown>) =>
      value.ok === true && Array.isArray(value.shots),
  })
}
