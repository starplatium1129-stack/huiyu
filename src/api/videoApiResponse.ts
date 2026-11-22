import type {
  VideoBatch,
  VideoBatchShot,
  VideoDefaults,
  VideoJob,
  VideoModelStatus,
  VideoQualityOption,
  VideoShotSize,
  VideoStoryboard,
} from './videoApi'
import { ApiClientError } from './client'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function isText(value: unknown): value is string {
  return typeof value === 'string'
}
function isNullableText(value: unknown): value is string | null {
  return value === null || isText(value)
}
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}
function isNonEmptyText(value: unknown): value is string {
  return isText(value) && value.trim().length > 0
}

export function isVideoShotSize(value: unknown): value is VideoShotSize {
  return value === 'wide' || value === 'medium' || value === 'closeup'
}
export function isVideoCamera(value: unknown): value is VideoDefaults['camera'] {
  return value === 'still' || value === 'push' || value === 'pull' || value === 'pan' || value === 'orbit'
}
export function isVideoMotion(value: unknown): value is VideoDefaults['motion'] {
  return value === 'subtle' || value === 'natural' || value === 'expressive'
}
export function isVideoDuration(value: unknown): value is Exclude<VideoDefaults['duration'], 2> {
  return value === 3 || value === 5 || value === 10 || value === 15
}
const isModelDuration = (value: unknown) => value === 2 || isVideoDuration(value)

function isVideoJob(value: unknown): value is VideoJob & { metadata?: unknown } {
  if (!isRecord(value)) return false
  return isNonEmptyText(value.id)
    && ['queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled'].includes(String(value.status))
    && ['comfy', 'native'].includes(String(value.provider))
    && (value.progress === null || isFiniteNumber(value.progress) && value.progress >= 0 && value.progress <= 1)
    && (value.needsReview === undefined || typeof value.needsReview === 'boolean')
    && (value.upstreamSettled === undefined || typeof value.upstreamSettled === 'boolean')
    && (value.unknown === undefined || typeof value.unknown === 'boolean')
    && isFiniteNumber(value.estimatedSeconds) && value.estimatedSeconds >= 0
    && isFiniteNumber(value.elapsedSeconds) && value.elapsedSeconds >= 0
    && isNonEmptyText(value.modelId)
    && isText(value.prompt)
    && isFiniteNumber(value.width) && value.width > 0
    && isFiniteNumber(value.height) && value.height > 0
    && isFiniteNumber(value.duration) && value.duration > 0
    && isFiniteNumber(value.fps) && value.fps > 0
    && isFiniteNumber(value.seed) && Number.isInteger(value.seed) && value.seed >= 0
    && isFiniteNumber(value.createdAt) && value.createdAt > 0
    && typeof value.resultAvailable === 'boolean'
    && isNullableText(value.resultUrl)
    && isNullableText(value.error)
    && isNullableText(value.code)
}

function isVideoModelStatus(value: unknown): value is VideoModelStatus {
  if (!isRecord(value)) return false
  return isNonEmptyText(value.id) && isText(value.label) && isText(value.family) && isText(value.tier)
    && isText(value.summary) && typeof value.executable === 'boolean' && typeof value.available === 'boolean'
    && isText(value.reason) && Array.isArray(value.modes)
    && value.modes.every((mode: unknown) => ['text', 'image', 'first-last-frame'].includes(String(mode)))
    && (value.durations === undefined || Array.isArray(value.durations) && value.durations.length > 0 && value.durations.every(isModelDuration))
    && (value.qualities === undefined || Array.isArray(value.qualities) && value.qualities.length > 0 && value.qualities.every(id => ['fast', 'standard', 'fine'].includes(id)))
    && (value.supportsNegative === undefined || typeof value.supportsNegative === 'boolean')
    && (value.supportsGeneratedAudio === undefined || typeof value.supportsGeneratedAudio === 'boolean')
    && (value.turboSteps === undefined || ['minimax-h3', 'wan2.2-i2v-a14b-gguf'].includes(String(value.id)) && Array.isArray(value.turboSteps)
      && value.turboSteps[0] === 4 && (value.turboSteps.length === 1 || value.turboSteps.length === 2 && value.turboSteps[1] === 8))
    && (value.drivingInput === undefined || value.drivingInput === 'audio' || value.drivingInput === 'video')
    && (value.attentionModes === undefined || Array.isArray(value.attentionModes) && value.attentionModes.length > 0
      && value.attentionModes.every(mode => ['auto', 'sdpa', 'sage', 'flash2', 'h3-sol', 'h3-sla', 'h3-fused'].includes(mode)))
    && (value.h3LightVae === undefined || value.id === 'minimax-h3' && typeof value.h3LightVae === 'boolean')
    && (value.canvases == null || isRecord(value.canvases) && Object.values(value.canvases).every(size =>
      Array.isArray(size) && size.length === 2 && size.every(n => Number.isSafeInteger(n) && n > 0)))
    && Array.isArray(value.requirements) && value.requirements.every(isText)
    && Array.isArray(value.missing) && value.missing.every(isText)
}

function isVideoQuality(value: unknown): value is VideoQualityOption {
  if (!isRecord(value)) return false
  return ['fast', 'standard', 'fine'].includes(String(value.id)) && isText(value.label) && isText(value.summary)
    && isRecord(value.sizes) && Object.values(value.sizes).every(isText)
}

function isVideoDefaults(value: unknown): value is VideoDefaults {
  if (!isRecord(value)) return false
  return isNonEmptyText(value.modelId)
    && ['landscape', 'portrait', 'square', 'original'].includes(String(value.aspectRatio))
    && isModelDuration(value.duration)
    && isVideoCamera(value.camera)
    && isVideoMotion(value.motion)
    && ['fast', 'standard', 'fine'].includes(String(value.quality))
}

export function isVideoStatusResponse(value: unknown): boolean {
  if (!isRecord(value)) return false
  return value.ok === true
    && (value.provider === undefined || value.provider === 'comfy' || value.provider === 'native')
    && typeof value.online === 'boolean'
    && isFiniteNumber(value.pending) && value.pending >= 0 && Number.isInteger(value.pending)
    && isFiniteNumber(value.maxPending) && value.maxPending > 0 && Number.isInteger(value.maxPending)
    && Array.isArray(value.models) && value.models.every(isVideoModelStatus)
    && Array.isArray(value.qualities) && value.qualities.every(isVideoQuality)
    && isVideoDefaults(value.defaults)
    && isRecord(value.t8) && typeof value.t8.available === 'boolean' && isText(value.t8.reason)
}

const attentionBackends = { sdpa: 'SDPA', slicedSdpa: '分块 SDPA', flash2: 'FlashAttention 2', sage: 'SageAttention',
  'h3-sol': 'Sol-Attn', 'h3-sla': 'Turbo-SLA', 'h3-fused': 'Fused Turbo 稀疏注意力' } as const

export function videoJobExecution(provider: string, status: string, metadata: unknown): VideoJob['execution'] {
  if (provider !== 'native' || status !== 'succeeded' || !isRecord(metadata) || !isRecord(metadata.nativeRuntime)) return
  const observed = metadata.nativeRuntime.videoAcceleration
  if (!isRecord(observed) || !isRecord(observed.calls)) return
  const { device, encoder, calls } = observed
  if (device !== 'cuda' && device !== 'rocm' && device !== 'xpu') return
  if (encoder !== 'h264_nvenc' && encoder !== 'h264_amf' && encoder !== 'h264_qsv' && encoder !== 'libx264') return
  const attention = []
  for (const [key, label] of Object.entries(attentionBackends)) {
    const count = calls[key]
    if (key.startsWith('h3-') && count === undefined) continue
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return
    if (count > 0) attention.push(label)
  }
  const decoder = metadata.nativeRuntime.h3Decoder === 'lightvae-lite-fp16' ? 'LightVAE'
    : metadata.nativeRuntime.h3Decoder === 'original' ? 'H3 原版' : undefined
  return { device: { cuda: 'CUDA', rocm: 'ROCm', xpu: 'XPU' }[device], attention, encoder, decoder }
}
export function videoJobResponse(value: unknown, expectedId?: string): { ok: true; job: VideoJob } {
  if (!isRecord(value) || value.ok !== true || !isVideoJob(value.job)) throw new ApiClientError('视频任务响应无效，请重新核对原请求。', { kind: 'invalid-response' })
  const job = value.job
  if (expectedId && job.id !== expectedId) throw new ApiClientError('视频任务编号与原请求不符。', { kind: 'invalid-response' })
  const upstreamSettled = job.upstreamSettled === true, unknown = job.unknown !== false
  const terminal = ['succeeded', 'failed', 'cancelled'].includes(job.status)
  return { ok: true, job: { ...job, upstreamSettled, unknown,
    execution: videoJobExecution(job.provider, job.status, job.metadata),
    needsReview: job.needsReview === true || unknown || terminal && !upstreamSettled || job.status === 'succeeded' && !job.resultAvailable } }
}

export function isVideoStoryboard(value: unknown): value is VideoStoryboard {
  if (!isRecord(value)) return false
  return isNonEmptyText(value.title) && isNonEmptyText(value.blueprintId) && isNonEmptyText(value.characterId)
    && Array.isArray(value.beats) && value.beats.every(isText)
    && Array.isArray(value.shots) && value.shots.every((shot: unknown) => isRecord(shot)
      && isText(shot.prompt) && isNullableText(shot.dialogue)
      && (shot.shotSize === null || isVideoShotSize(shot.shotSize))
      && isVideoCamera(shot.camera)
      && isFiniteNumber(shot.duration) && shot.duration > 0
      && (shot.firstFramePrompt === null || isText(shot.firstFramePrompt)))
}

function isVideoBatchShot(value: unknown): value is VideoBatchShot {
  if (!isRecord(value)) return false
  return isFiniteNumber(value.index) && Number.isInteger(value.index) && value.index >= 1
    && ['pending', 'queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(String(value.status))
    && isText(value.prompt)
    && isNullableText(value.dialogue)
    && (value.shotSize === null || isVideoShotSize(value.shotSize))
    && isVideoCamera(value.camera)
    && isVideoMotion(value.motion)
    && isFiniteNumber(value.duration) && value.duration > 0
    && isFiniteNumber(value.seed) && Number.isInteger(value.seed) && value.seed >= 0
    && isFiniteNumber(value.attempts) && Number.isInteger(value.attempts) && value.attempts >= 0
    && isNullableText(value.error) && isNullableText(value.code)
    && typeof value.resultAvailable === 'boolean'
    && isNullableText(value.resultUrl)
}

function isVideoBatch(value: unknown): value is VideoBatch {
  if (!isRecord(value)) return false
  return isNonEmptyText(value.id)
    && ['running', 'paused', 'done', 'cancelled'].includes(String(value.status))
    && (value.upstreamSettled === undefined || typeof value.upstreamSettled === 'boolean')
    && (value.unknown === undefined || typeof value.unknown === 'boolean')
    && (value.needsReview === undefined || typeof value.needsReview === 'boolean')
    && (value.retrySource === undefined || isRecord(value.retrySource) && isNonEmptyText(value.retrySource.batchId)
      && Array.isArray(value.retrySource.stepIndices) && value.retrySource.stepIndices.length > 0
      && value.retrySource.stepIndices.every(index => Number.isSafeInteger(index) && Number(index) >= 0))
    && isNonEmptyText(value.modelId)
    && ['landscape', 'portrait', 'square'].includes(String(value.aspectRatio))
    && ['fast', 'standard', 'fine'].includes(String(value.quality))
    && [4, 8].includes(Number(value.steps))
    && typeof value.linkLastFrame === 'boolean'
    && isRecord(value.progress)
    && isFiniteNumber(value.progress.total) && value.progress.total >= 0 && Number.isInteger(value.progress.total)
    && isFiniteNumber(value.progress.succeeded) && value.progress.succeeded >= 0 && Number.isInteger(value.progress.succeeded)
    && isFiniteNumber(value.progress.failed) && value.progress.failed >= 0 && Number.isInteger(value.progress.failed)
    && value.progress.succeeded + value.progress.failed <= value.progress.total
    && isFiniteNumber(value.createdAt) && value.createdAt > 0
    && Array.isArray(value.shots) && value.shots.every(isVideoBatchShot)
    && typeof value.concatAvailable === 'boolean'
    && isNullableText(value.concatUrl)
}

function isVideoBatchResponse(value: unknown): boolean {
  return isRecord(value) && value.ok === true && isVideoBatch(value.batch)
}
export function videoBatchResponse(value: unknown, expectedId?: string): { ok: true; batch: VideoBatch } {
  if (!isRecord(value) || !isVideoBatchResponse(value)) throw new ApiClientError('分镜任务响应无效，请重新核对原请求。', { kind: 'invalid-response' })
  const batch = value.batch as VideoBatch
  if (expectedId && batch.id !== expectedId) throw new ApiClientError('分镜任务编号与原请求不符。', { kind: 'invalid-response' })
  const upstreamSettled = batch.upstreamSettled === true, unknown = batch.unknown !== false
  return { ok: true, batch: { ...batch, shots: batch.shots.map(shot => ({ ...shot })), progress: { ...batch.progress },
    ...(batch.retrySource ? { retrySource: { batchId: batch.retrySource.batchId, stepIndices: [...batch.retrySource.stepIndices] } } : {}), upstreamSettled, unknown,
    needsReview: batch.needsReview === true || unknown || batch.status !== 'running' && !upstreamSettled } }
}
