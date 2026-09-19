import { apiClient, type ApiClient, type ApiResponseObject } from './client.ts'

/**
 * /api/generation/* 统一客户端 —— 出图引擎网关（Comfy / WebUI 任务路由）。
 * 二进制结果（/jobs/:id/result）不属于 JSON 信封契约，仍由调用方直接 fetch。
 */

export const GENERATION_API_TIMEOUTS = {
  status: 15_000,
  create: 60_000,
  job: 15_000,
  delete: 10_000,
} as const

import type { GenerationStatus, GenerationJobEnvelope } from '../types/generation.ts'
export type { GenerationJob, GenerationStatus, GenerationJobEnvelope } from '../types/generation.ts'
import { decodeGenerationJobEnvelope, isGenerationStatus } from './generationResponse.ts'
/** 服务端白名单字段（routes/generation.js ALLOWED） */
export interface GenerationJobPayload {
  prompt: string
  negative?: string
  profile?: string
  modelId?: string
  character?: string
  loras?: Array<{ id: string; strength: number }>
  width?: number
  height?: number
  steps?: number
  cfg?: number
  seed?: number
  sampler?: string
  scheduler?: string
  hiresFix?: boolean
  hiresScale?: number
  hiresUpscaler?: string
  hiresSteps?: number
  denoisingStrength?: number
  faceDetailer?: boolean
  adultEnabled?: boolean
}

export interface GenerationCallOptions {
  signal?: AbortSignal
}

export interface GenerationApi {
  getStatus(options?: GenerationCallOptions): Promise<GenerationStatus>
  createJob(payload: GenerationJobPayload, options?: GenerationCallOptions): Promise<GenerationJobEnvelope>
  getJob(id: string, options?: GenerationCallOptions): Promise<GenerationJobEnvelope>
  deleteJob(id: string, options?: GenerationCallOptions): Promise<GenerationJobEnvelope>
}

export function createGenerationApi(client: ApiClient = apiClient): GenerationApi {
  return {
    getStatus(options = {}) {
      return client.request<GenerationStatus>('/api/generation/status', {
        cache: 'no-store',
        signal: options.signal,
        timeoutMs: GENERATION_API_TIMEOUTS.status,
        validate: isGenerationStatus,
      })
    },
    createJob(payload, options = {}) {
      return client.request<ApiResponseObject>('/api/generation/jobs', {
        method: 'POST',
        cache: 'no-store',
        body: payload,
        signal: options.signal,
        timeoutMs: GENERATION_API_TIMEOUTS.create,
      }).then(decodeGenerationJobEnvelope)
    },
    getJob(id, options = {}) {
      return client.request<ApiResponseObject>(
        `/api/generation/jobs/${encodeURIComponent(id)}`,
        { cache: 'no-store', signal: options.signal, timeoutMs: GENERATION_API_TIMEOUTS.job },
      ).then(decodeGenerationJobEnvelope)
    },
    deleteJob(id, options = {}) {
      return client.request<ApiResponseObject>(
        `/api/generation/jobs/${encodeURIComponent(id)}`,
        { method: 'DELETE', cache: 'no-store', signal: options.signal, timeoutMs: GENERATION_API_TIMEOUTS.delete },
      ).then(decodeGenerationJobEnvelope)
    },
  }
}

export const generationApi = createGenerationApi()
