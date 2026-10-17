import { apiClient, type ApiResponseObject } from './client.ts'
import type { ChatStatus, ConfiguredHostConfig, HostConfig, ProviderTestResult } from '../types/api.ts'
import { parseChatStatus } from '../utils/chatStatus.ts'

const CHAT_API_TIMEOUTS = {
  status: 10_000,
  host: 10_000,
  hostAction: 30_000,
  providerTest: 30_000,
} as const

export interface ChatCallOptions { signal?: AbortSignal }
export interface HostConfigPayload { baseUrl: string; model: string; apiKey: string }

function isObject(value: unknown): value is ApiResponseObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasNoApiKey(value: ApiResponseObject): boolean {
  return !Object.prototype.hasOwnProperty.call(value, 'apiKey')
}

function isHostConfig(value: ApiResponseObject): boolean {
  if (!hasNoApiKey(value) || typeof value.configured !== 'boolean') return false
  if (value.configured) return isConfiguredHostConfig(value)
  return (value.model === undefined || typeof value.model === 'string')
    && (value.baseUrl === undefined || typeof value.baseUrl === 'string')
}

function isConfiguredHostConfig(value: ApiResponseObject): boolean {
  return value.configured === true
    && typeof value.model === 'string' && Boolean(value.model.trim())
    && typeof value.baseUrl === 'string' && Boolean(value.baseUrl.trim())
    && hasNoApiKey(value)
}

function isProviderTest(value: ApiResponseObject): boolean {
  return value.ok === true
    && Array.isArray(value.models)
    && value.models.every(model => typeof model === 'string')
}

export interface ChatApi {
  getStatus(options?: ChatCallOptions): Promise<ChatStatus>
  getHostConfig(options?: ChatCallOptions): Promise<HostConfig>
  saveHostConfig(payload: HostConfigPayload, options?: ChatCallOptions): Promise<ConfiguredHostConfig>
  clearHostConfig(options?: ChatCallOptions): Promise<{ ok: true; configured: false }>
  testProvider(payload: HostConfigPayload, options?: ChatCallOptions): Promise<ProviderTestResult>
}

export const chatApi: ChatApi = {
  getStatus(options = {}) {
    return apiClient.request<ChatStatus>('/api/chat-status', {
      cache: 'no-store', signal: options.signal, timeoutMs: CHAT_API_TIMEOUTS.status,
      validate: value => typeof value.online === 'boolean'
        && typeof value.model === 'string'
        && Array.isArray(value.models)
        && value.models.every(model => isObject(model) && typeof model.name === 'string'),
    })
  },
  getHostConfig(options = {}) {
    return apiClient.request<HostConfig>('/api/chat-provider/host-config', {
      cache: 'no-store', signal: options.signal, timeoutMs: CHAT_API_TIMEOUTS.host,
      // 准静态配置：30s 内存 TTL 去抖（2026-08-28 审计 P1-8）。
      // saveHostConfig/clearHostConfig 成功后由 client 失效同 URL 缓存。
      cacheTtlMs: 30_000,
      validate: isHostConfig,
    })
  },
  saveHostConfig(payload, options = {}) {
    return apiClient.request<ConfiguredHostConfig>('/api/chat-provider/host-config', {
      method: 'POST', cache: 'no-store', body: payload, signal: options.signal,
      timeoutMs: CHAT_API_TIMEOUTS.hostAction, validate: value => value.ok === true && isConfiguredHostConfig(value),
    })
  },
  clearHostConfig(options = {}) {
    return apiClient.request<{ ok: true; configured: false }>('/api/chat-provider/host-config', {
      method: 'DELETE', cache: 'no-store', signal: options.signal,
      timeoutMs: CHAT_API_TIMEOUTS.hostAction,
      validate: value => value.ok === true && isHostConfig(value) && value.configured === false,
    })
  },
  testProvider(payload, options = {}) {
    return apiClient.request<ProviderTestResult>('/api/chat-provider/test', {
      method: 'POST', cache: 'no-store', body: payload, signal: options.signal,
      timeoutMs: CHAT_API_TIMEOUTS.providerTest, validate: isProviderTest,
    })
  },
}
