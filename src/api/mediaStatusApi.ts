import { apiClient, type ApiResponseObject } from './client.ts'
import type { Live2DStatusResponse, SDStatusResponse } from '../types/api.ts'
import { parseSDStatus } from '../utils/sdStatus.ts'

const MEDIA_STATUS_API_TIMEOUT = 10_000

export interface MediaStatusCallOptions { signal?: AbortSignal }

function isObject(value: unknown): value is ApiResponseObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isLive2DStatus(value: ApiResponseObject): boolean {
  return isObject(value.models)
}

function isSDStatus(value: ApiResponseObject): boolean {
  return typeof value.online === 'boolean' && Array.isArray(value.models)
    && Array.isArray(value.samplers) && Array.isArray(value.schedulers) && Array.isArray(value.upscalers)
}

export interface MediaStatusApi {
  getLive2DStatus(options?: MediaStatusCallOptions): Promise<Live2DStatusResponse>
  getSDStatus(options?: MediaStatusCallOptions): Promise<SDStatusResponse>
}

export const mediaStatusApi: MediaStatusApi = {
  getLive2DStatus(options = {}) {
    return apiClient.request<Live2DStatusResponse>('/api/live2d-status', {
      cache: 'no-store', signal: options.signal, timeoutMs: MEDIA_STATUS_API_TIMEOUT,
      validate: isLive2DStatus,
    })
  },
  getSDStatus(options = {}) {
    return apiClient.request<SDStatusResponse>('/api/sd-status', {
      cache: 'no-store', signal: options.signal, timeoutMs: MEDIA_STATUS_API_TIMEOUT,
      validate: isSDStatus,
    })
  },
}
