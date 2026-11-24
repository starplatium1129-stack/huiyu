import { apiClient, type ApiResponseObject } from './client.ts'
import type { ChatStatus, ConfiguredHostConfig, HostConfig, ProviderTestResult } from '../types/api.ts'

const CHAT_API_TIMEOUTS = {
  status: 10_000,
  host: 10_000,
  hostAction: 30_000,
  signOut: 55_000,
  providerTest: 30_000,
} as const

export interface ChatCallOptions { signal?: AbortSignal }
export interface HostConfigPayload { baseUrl: string; model: string; apiKey: string }
export interface MuseChatStatus {
  available: boolean
  receiving: boolean
  transport: 'tailscale' | 'relay' | null
}
export interface ChatGptAccount {
  clientId: string
  label: string
  email: string | null
  name: string | null
  hasSession: boolean
  planEnabled: boolean
  selectedModel: string
  selectedModelName: string
  active: boolean
}
export interface ChatGptAuthFlow {
  status: 'idle' | 'pending' | 'completed' | 'error'
  error: string | null
  errorCode: string | null
  startedAt: number | null
  retryRegistration: boolean
}
export interface ChatGptStatus {
  supported: boolean
  signedIn: boolean
  planEnabled: boolean
  usagePaused: boolean
  activeClientId: string | null
  selectedModel: string
  selectedModelName: string
  welcomeConfirmed: boolean
  accounts: ChatGptAccount[]
  authFlow: ChatGptAuthFlow
}
export interface ChatGptModel {
  slug: string
  displayName: string
}
export interface ChatGptModelsResult {
  ok: true
  clientId: string
  models: ChatGptModel[]
  selectedModel: string
  selectedModelName: string
}
export interface ChatGptSignOutResult {
  ok: true
  remoteRevoked: boolean
  status: ChatGptStatus
}

function isObject(value: unknown): value is ApiResponseObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isChatGptAccount(value: unknown): value is ChatGptAccount {
  return isObject(value)
    && typeof value.clientId === 'string'
    && typeof value.label === 'string'
    && (value.email === null || typeof value.email === 'string')
    && (value.name === null || typeof value.name === 'string')
    && typeof value.hasSession === 'boolean'
    && typeof value.planEnabled === 'boolean'
    && typeof value.selectedModel === 'string'
    && typeof value.selectedModelName === 'string'
    && typeof value.active === 'boolean'
}

function isChatGptAuthFlow(value: unknown): value is ChatGptAuthFlow {
  return isObject(value)
    && (value.status === 'idle' || value.status === 'pending' || value.status === 'completed' || value.status === 'error')
    && (value.error === null || typeof value.error === 'string')
    && (value.errorCode === null || typeof value.errorCode === 'string')
    && (value.startedAt === null || typeof value.startedAt === 'number')
    && typeof value.retryRegistration === 'boolean'
}

function isChatGptStatus(value: unknown): value is ChatGptStatus {
  return isObject(value)
    && typeof value.supported === 'boolean'
    && typeof value.signedIn === 'boolean'
    && typeof value.planEnabled === 'boolean'
    && typeof value.usagePaused === 'boolean'
    && (value.activeClientId === null || typeof value.activeClientId === 'string')
    && typeof value.selectedModel === 'string'
    && typeof value.selectedModelName === 'string'
    && typeof value.welcomeConfirmed === 'boolean'
    && Array.isArray(value.accounts) && value.accounts.every(isChatGptAccount)
    && isChatGptAuthFlow(value.authFlow)
}

function isChatGptModels(value: unknown): value is ChatGptModelsResult {
  return isObject(value)
    && value.ok === true
    && typeof value.clientId === 'string'
    && Array.isArray(value.models)
    && value.models.every(item => isObject(item) && typeof item.slug === 'string' && typeof item.displayName === 'string')
    && typeof value.selectedModel === 'string'
    && typeof value.selectedModelName === 'string'
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
  getMuseStatus(options?: ChatCallOptions): Promise<MuseChatStatus>
  getChatGptStatus(options?: ChatCallOptions): Promise<ChatGptStatus>
  startChatGptAuth(payload: { mode: 'new' | 'retry' | 'reauth' | 'consent'; clientId?: string }, options?: ChatCallOptions): Promise<ChatGptStatus>
  cancelChatGptAuth(options?: ChatCallOptions): Promise<ChatGptStatus>
  getChatGptModels(options?: ChatCallOptions & { refresh?: boolean }): Promise<ChatGptModelsResult>
  selectChatGptAccount(clientId: string, options?: ChatCallOptions): Promise<ChatGptStatus>
  setChatGptModel(clientId: string, model: string, options?: ChatCallOptions): Promise<ChatGptStatus>
  resumeChatGptUsage(clientId: string, options?: ChatCallOptions): Promise<ChatGptStatus>
  removeChatGptAccount(clientId: string, options?: ChatCallOptions): Promise<ChatGptSignOutResult>
  confirmChatGptWelcome(options?: ChatCallOptions): Promise<ChatGptStatus>
  signOutChatGpt(clientId?: string, options?: ChatCallOptions): Promise<ChatGptSignOutResult>
  getStatus(options?: ChatCallOptions): Promise<ChatStatus>
  getHostConfig(options?: ChatCallOptions): Promise<HostConfig>
  saveHostConfig(payload: HostConfigPayload, options?: ChatCallOptions): Promise<ConfiguredHostConfig>
  clearHostConfig(options?: ChatCallOptions): Promise<{ ok: true; configured: false }>
  testProvider(payload: HostConfigPayload, options?: ChatCallOptions): Promise<ProviderTestResult>
}

export const chatApi: ChatApi = {
  getMuseStatus(options = {}) {
    return apiClient.request<MuseChatStatus>('/api/chat/muse/status', {
      cache: 'no-store', signal: options.signal, timeoutMs: CHAT_API_TIMEOUTS.status,
      validate: value => typeof value.available === 'boolean' && typeof value.receiving === 'boolean'
        && (value.transport === null || value.transport === 'tailscale' || value.transport === 'relay'),
    })
  },
  getChatGptStatus(options = {}) {
    return apiClient.request<ChatGptStatus>('/api/chat/chatgpt/status', {
      cache: 'no-store', signal: options.signal, timeoutMs: CHAT_API_TIMEOUTS.status,
      validate: isChatGptStatus,
    })
  },
  startChatGptAuth(payload, options = {}) {
    return apiClient.request<ChatGptStatus>('/api/chat/chatgpt/auth/start', {
      method: 'POST', cache: 'no-store', body: payload, signal: options.signal,
      timeoutMs: CHAT_API_TIMEOUTS.hostAction,
      validate: isChatGptStatus,
    })
  },
  cancelChatGptAuth(options = {}) {
    return apiClient.request<ChatGptStatus>('/api/chat/chatgpt/auth/cancel', {
      method: 'POST', cache: 'no-store', signal: options.signal,
      timeoutMs: CHAT_API_TIMEOUTS.hostAction,
      validate: isChatGptStatus,
    })
  },
  getChatGptModels(options = {}) {
    const path = options.refresh ? '/api/chat/chatgpt/models?refresh=1' : '/api/chat/chatgpt/models'
    return apiClient.request<ChatGptModelsResult>(path, {
      cache: 'no-store', signal: options.signal, timeoutMs: CHAT_API_TIMEOUTS.providerTest,
      validate: isChatGptModels,
    })
  },
  selectChatGptAccount(clientId, options = {}) {
    return apiClient.request<ChatGptStatus>('/api/chat/chatgpt/accounts/select', {
      method: 'POST', cache: 'no-store', body: { clientId }, signal: options.signal,
      timeoutMs: CHAT_API_TIMEOUTS.hostAction,
      validate: isChatGptStatus,
    })
  },
  setChatGptModel(clientId, model, options = {}) {
    return apiClient.request<ChatGptStatus>('/api/chat/chatgpt/accounts/model', {
      method: 'POST', cache: 'no-store', body: { clientId, model }, signal: options.signal,
      timeoutMs: CHAT_API_TIMEOUTS.hostAction,
      validate: isChatGptStatus,
    })
  },
  resumeChatGptUsage(clientId, options = {}) {
    return apiClient.request<ChatGptStatus>('/api/chat/chatgpt/usage/resume', {
      method: 'POST', cache: 'no-store', body: { clientId }, signal: options.signal,
      timeoutMs: CHAT_API_TIMEOUTS.hostAction,
      validate: isChatGptStatus,
    })
  },
  removeChatGptAccount(clientId, options = {}) {
    return apiClient.request<ChatGptSignOutResult>('/api/chat/chatgpt/accounts/remove', {
      method: 'POST', cache: 'no-store', body: { clientId }, signal: options.signal,
      timeoutMs: CHAT_API_TIMEOUTS.signOut,
      validate: value => value.ok === true && typeof value.remoteRevoked === 'boolean' && isChatGptStatus(value.status),
    })
  },
  confirmChatGptWelcome(options = {}) {
    return apiClient.request<ChatGptStatus>('/api/chat/chatgpt/welcome-confirm', {
      method: 'POST', cache: 'no-store', signal: options.signal,
      timeoutMs: CHAT_API_TIMEOUTS.status,
      validate: isChatGptStatus,
    })
  },
  signOutChatGpt(clientId, options = {}) {
    return apiClient.request<ChatGptSignOutResult>('/api/chat/chatgpt/sign-out', {
      method: 'POST', cache: 'no-store', body: clientId ? { clientId } : {}, signal: options.signal,
      timeoutMs: CHAT_API_TIMEOUTS.signOut,
      validate: value => value.ok === true && typeof value.remoteRevoked === 'boolean' && isChatGptStatus(value.status),
    })
  },
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
