import { apiClient, type ApiResponseObject } from './client.ts'

/**
 * /api/generation/* 统一客户端 —— 出图引擎网关（Comfy / WebUI 任务路由）。
 * 二进制结果（/jobs/:id/result）不属于 JSON 信封契约，仍由调用方直接 fetch。
 */

const GENERATION_API_TIMEOUTS = {
  status: 15_000,
  job: 15_000,
  delete: 10_000,
} as const

import type { GenerationStatus, GenerationJobEnvelope } from '../types/generation.ts'
export type { GenerationJobEnvelope } from '../types/generation.ts';
import { decodeGenerationJobEnvelope, isGenerationStatus } from './generationResponse.ts'
export interface GenerationCallOptions {
  signal?: AbortSignal
}

export interface GenerationApi {
  getStatus(options?: GenerationCallOptions): Promise<GenerationStatus>
  getJob(id: string, options?: GenerationCallOptions): Promise<GenerationJobEnvelope>
  deleteJob(id: string, options?: GenerationCallOptions): Promise<GenerationJobEnvelope>
}

export const generationApi: GenerationApi = {
  getStatus(options = {}) {
    return apiClient.request<GenerationStatus>('/api/generation/status', {
      cache: 'no-store',
      signal: options.signal,
      timeoutMs: GENERATION_API_TIMEOUTS.status,
      validate: isGenerationStatus,
    })
  },
  getJob(id, options = {}) {
    return apiClient.request<ApiResponseObject>(
      `/api/generation/jobs/${encodeURIComponent(id)}`,
      { cache: 'no-store', signal: options.signal, timeoutMs: GENERATION_API_TIMEOUTS.job },
    ).then(decodeGenerationJobEnvelope)
  },
  deleteJob(id, options = {}) {
    return apiClient.request<ApiResponseObject>(
      `/api/generation/jobs/${encodeURIComponent(id)}`,
      { method: 'DELETE', cache: 'no-store', signal: options.signal, timeoutMs: GENERATION_API_TIMEOUTS.delete },
    ).then(decodeGenerationJobEnvelope)
  },
}
