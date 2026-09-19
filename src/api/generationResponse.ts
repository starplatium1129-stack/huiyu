import { ApiClientError, type ApiResponseObject } from './client.ts'
import { generationTask } from '../utils/generationTask.ts'
import type { GenerationJob, GenerationJobEnvelope, GenerationStatus } from '../types/generation.ts'

const object = (v: unknown): v is ApiResponseObject => typeof v === 'object' && v !== null && !Array.isArray(v)
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const text = (v: unknown): v is string => typeof v === 'string'
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(text)
const optional = (v: unknown, check: (v: unknown) => boolean, nullable = false) =>
  v === undefined || (nullable && v === null) || check(v)

/** Wire status is an open string; generationTask owns known stages and the explicit unknown state. */
function isJob(v: unknown): v is GenerationJob {
  if (!object(v)) return false
  return text(v.id) && v.id.trim().length > 0 && text(v.status) && v.status.trim().length > 0
    && (v.provider === 'comfy' || v.provider === 'webui')
    && optional(v.progress, n => finite(n) && n >= 0 && n <= 1, true)
    && optional(v.elapsedSeconds, n => finite(n) && n >= 0)
    && optional(v.seed, finite, true)
    && optional(v.resultAvailable, n => typeof n === 'boolean')
    && ['progressText', 'currentNode', 'resultUrl', 'error', 'code'].every(key => optional(v[key], text, true))
    && optional(v.metadata, m => object(m) && optional(m.seed, finite) && optional(m.provider, text))
}

export function decodeGenerationJobEnvelope(value: unknown): GenerationJobEnvelope {
  const rawJob = object(value) && object(value.job) ? value.job : null
  // The current Comfy serializer permits numeric upstream error codes.
  const job = rawJob ? { ...rawJob, code: finite(rawJob.code) ? String(rawJob.code) : rawJob.code } : null
  if (!object(value) || value.ok !== true || !isJob(job)) {
    throw new ApiClientError('服务器返回了无效响应：生成任务字段不符合契约', { kind: 'invalid-response' })
  }
  const task = generationTask(job.status, job.progress)
  return { ok: true, job: { ...job, progress: task.progress === null ? null : task.progress / 100 } }
}

export function isGenerationStatus(v: ApiResponseObject): v is ApiResponseObject & GenerationStatus {
  const capabilities = v.capabilities
  return v.ok === true && typeof v.online === 'boolean'
    && (v.provider === null || v.provider === 'comfy' || v.provider === 'webui')
    && typeof v.webuiOnline === 'boolean' && typeof v.comfyFallbackOnline === 'boolean'
    && text(v.checkpoint) && strings(v.samplers) && strings(v.schedulers) && strings(v.models)
    && Array.isArray(v.loras) && v.loras.every(l => object(l) && text(l.id) && text(l.character) && typeof l.available === 'boolean')
    && finite(v.pending) && Number.isInteger(v.pending) && v.pending >= 0
    && finite(v.maxPending) && Number.isInteger(v.maxPending) && v.maxPending > 0
    && object(capabilities) && ['basic', 'hires', 'faceDetailer'].every(key => typeof capabilities[key] === 'boolean')
    && strings(capabilities.hiresUpscalers)
}

