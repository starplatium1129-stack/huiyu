import type {
  VideoBatch,
  VideoBatchShot,
  VideoDefaults,
  VideoJob,
  VideoModelStatus,
  VideoQualityOption,
  VideoStoryboard,
} from './videoApi'

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

export function isVideoJob(value: unknown): value is VideoJob {
  if (!isRecord(value)) return false
  return isNonEmptyText(value.id)
    && ['queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled'].includes(String(value.status))
    && value.provider === 'comfy'
    && isFiniteNumber(value.progress) && value.progress >= 0 && value.progress <= 1
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
    && [3, 5, 10, 15].includes(Number(value.duration))
    && ['still', 'push', 'pull', 'pan', 'orbit'].includes(String(value.camera))
    && ['subtle', 'natural', 'expressive'].includes(String(value.motion))
    && ['fast', 'standard', 'fine'].includes(String(value.quality))
}

export function isVideoStatusResponse(value: unknown): boolean {
  if (!isRecord(value)) return false
  return value.ok === true
    && typeof value.online === 'boolean'
    && isFiniteNumber(value.pending) && value.pending >= 0 && Number.isInteger(value.pending)
    && isFiniteNumber(value.maxPending) && value.maxPending > 0 && Number.isInteger(value.maxPending)
    && Array.isArray(value.models) && value.models.every(isVideoModelStatus)
    && Array.isArray(value.qualities) && value.qualities.every(isVideoQuality)
    && isVideoDefaults(value.defaults)
    && isRecord(value.t8) && typeof value.t8.available === 'boolean' && isText(value.t8.reason)
}

export function isVideoJobResponse(value: unknown): boolean {
  return isRecord(value) && value.ok === true && isVideoJob(value.job)
}

export function isVideoStoryboard(value: unknown): value is VideoStoryboard {
  if (!isRecord(value)) return false
  return isNonEmptyText(value.title) && isNonEmptyText(value.blueprintId) && isNonEmptyText(value.characterId)
    && Array.isArray(value.beats) && value.beats.every(isText)
    && Array.isArray(value.shots) && value.shots.every((shot: unknown) => isRecord(shot)
      && isText(shot.prompt) && isNullableText(shot.dialogue)
      && (shot.shotSize === null || ['wide', 'medium', 'closeup'].includes(String(shot.shotSize)))
      && ['still', 'push', 'pull', 'pan', 'orbit'].includes(String(shot.camera))
      && isFiniteNumber(shot.duration) && shot.duration > 0
      && (shot.firstFramePrompt === null || isText(shot.firstFramePrompt)))
}

function isVideoBatchShot(value: unknown): value is VideoBatchShot {
  if (!isRecord(value)) return false
  return isFiniteNumber(value.index) && Number.isInteger(value.index) && value.index >= 1
    && ['pending', 'queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(String(value.status))
    && isText(value.prompt)
    && isNullableText(value.dialogue)
    && (value.shotSize === null || ['wide', 'medium', 'closeup'].includes(String(value.shotSize)))
    && ['still', 'push', 'pull', 'pan', 'orbit'].includes(String(value.camera))
    && ['subtle', 'natural', 'expressive'].includes(String(value.motion))
    && isFiniteNumber(value.duration) && value.duration > 0
    && isFiniteNumber(value.seed) && Number.isInteger(value.seed) && value.seed >= 0
    && isFiniteNumber(value.attempts) && Number.isInteger(value.attempts) && value.attempts >= 0
    && isNullableText(value.error) && isNullableText(value.code)
    && typeof value.resultAvailable === 'boolean'
    && isNullableText(value.resultUrl)
}

export function isVideoBatch(value: unknown): value is VideoBatch {
  if (!isRecord(value)) return false
  return isNonEmptyText(value.id)
    && ['running', 'paused', 'done', 'cancelled'].includes(String(value.status))
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

export function isVideoBatchResponse(value: unknown): boolean {
  return isRecord(value) && value.ok === true && isVideoBatch(value.batch)
}
