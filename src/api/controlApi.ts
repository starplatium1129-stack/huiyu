import { ApiClientError, apiClient, type ApiClient, type ApiResponseObject } from './client.ts'
import type {
  ControlActionResult,
  ControlConfigPayload,
  ControlConfigResult,
  ControlDiagnostics,
  ControlLogs,
  ControlPreferenceResult,
  ControlShareLinkResult,
  ControlStatus,
} from '../types/api.ts'

export const CONTROL_API_TIMEOUTS = {
  quick: 10_000,
  action: 30_000,
} as const

export type ControlService = 'voice' | 'webui' | 'comfy' | 'ollama'
export type ControlServiceAction = 'start' | 'stop' | 'unload'

export interface ControlCallOptions {
  signal?: AbortSignal
}

export interface ControlStatusOptions extends ControlCallOptions {
  fresh?: boolean
}

export interface ControlApi {
  getStatus(options?: ControlStatusOptions): Promise<ControlStatus>
  getShareLink(options?: ControlCallOptions): Promise<ControlShareLinkResult>
  getLogs(since: number, options?: ControlCallOptions): Promise<ControlLogs>
  saveConfig(payload: ControlConfigPayload, options?: ControlCallOptions): Promise<ControlConfigResult>
  savePreference(autoStartVoice: boolean, options?: ControlCallOptions): Promise<ControlPreferenceResult>
  serviceAction(service: ControlService, action: ControlServiceAction, options?: ControlCallOptions): Promise<ControlActionResult>
  switchMode(mode: 'draw' | 'chat', options?: ControlCallOptions): Promise<ControlActionResult>
  start(enableTunnel: boolean, options?: ControlCallOptions): Promise<ControlActionResult>
  stop(options?: ControlCallOptions): Promise<ControlActionResult>
  getDiagnostics(options?: ControlCallOptions): Promise<ControlDiagnostics>
}

function isObject(value: unknown): value is ApiResponseObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isControlOperation(value: unknown): boolean {
  return isObject(value)
    && typeof value.id === 'string'
    && typeof value.kind === 'string'
    && typeof value.label === 'string'
    && (value.status === 'running' || value.status === 'completed' || value.status === 'failed')
    && typeof value.stageIndex === 'number'
    && Array.isArray(value.stages)
    && value.stages.every(stage => typeof stage === 'string')
    && typeof value.message === 'string'
    && typeof value.startedAt === 'number'
    && typeof value.finishedAt === 'number'
    && typeof value.error === 'string'
}

function isControlScripts(value: unknown): boolean {
  return isObject(value)
    && typeof value.voiceStart === 'boolean'
    && typeof value.voiceStop === 'boolean'
    && typeof value.webui === 'boolean'
    && typeof value.comfy === 'boolean'
}

function isControlStatus(value: ApiResponseObject): boolean {
  return typeof value.ok === 'boolean'
    && typeof value.running === 'boolean'
    && typeof value.sdOnline === 'boolean'
    && typeof value.comfyOnline === 'boolean'
    && typeof value.ttsOnline === 'boolean'
    && typeof value.ollamaOnline === 'boolean'
    && Array.isArray(value.ollamaModels)
    && value.ollamaModels.every(model => typeof model === 'string')
    && typeof value.ollamaVram === 'number'
    && typeof value.webuiManaged === 'boolean'
    && typeof value.comfyManaged === 'boolean'
    && typeof value.modeBusy === 'boolean'
    && (value.operation === null || isControlOperation(value.operation))
    && typeof value.sdHost === 'string'
    && typeof value.comfyHost === 'string'
    && typeof value.ttsHost === 'string'
    && typeof value.ollamaHost === 'string'
    && typeof value.localLink === 'string'
    && typeof value.shareLinkAvailable === 'boolean'
    && (value.tunnelStatus === 'active' || value.tunnelStatus === 'waiting' || value.tunnelStatus === 'disabled')
    && typeof value.tunnelAvailable === 'boolean'
    && typeof value.uptime === 'number'
    && isObject(value.voices)
    && isControlScripts(value.scripts)
}

function isDegradedControlStatus(value: ApiResponseObject): boolean {
  return value.ok === false && value.degraded === true && isControlStatus(value)
}

function isShareLink(value: ApiResponseObject): boolean {
  return value.ok === true && typeof value.shareLink === 'string'
}

function isLogs(value: ApiResponseObject): boolean {
  return Array.isArray(value.logs)
    && value.logs.every(line => typeof line === 'string')
    && typeof value.total === 'number'
    && (value.operation === null || isControlOperation(value.operation))
}

function isSuccess(value: ApiResponseObject): boolean {
  return value.ok === true
}

function isDiagnostics(value: ApiResponseObject): boolean {
  return typeof value.timestamp === 'string'
    && typeof value.uptime === 'number'
    && typeof value.port === 'number'
    && typeof value.nodeVersion === 'string'
    && typeof value.platform === 'string'
}

export function createControlApi(client: ApiClient = apiClient): ControlApi {
  function post<T extends object>(path: string, body: unknown, options: ControlCallOptions): Promise<T> {
    return client.request<T>(path, {
      method: 'POST', cache: 'no-store', body, signal: options.signal,
      timeoutMs: CONTROL_API_TIMEOUTS.action, validate: isSuccess,
    })
  }

  async function getStatus(options: ControlStatusOptions = {}): Promise<ControlStatus> {
    try {
      return await client.request<ControlStatus>(`/api/status${options.fresh ? '?fresh=1' : ''}`, {
        cache: 'no-store',
        signal: options.signal,
        timeoutMs: CONTROL_API_TIMEOUTS.quick,
        validate: isControlStatus,
      })
    } catch (error) {
      const body = error instanceof ApiClientError ? error.responseBody : null
      if (error instanceof ApiClientError && error.status === 200 && body && isDegradedControlStatus(body)) {
        return body as unknown as ControlStatus
      }
      throw error
    }
  }

  return {
    getStatus,

    getShareLink(options: ControlCallOptions = {}) {
      return client.request<ControlShareLinkResult>('/api/share-link', {
        cache: 'no-store',
        signal: options.signal,
        timeoutMs: CONTROL_API_TIMEOUTS.quick,
        validate: isShareLink,
      })
    },

    getLogs(since: number, options: ControlCallOptions = {}) {
      return client.request<ControlLogs>(`/api/logs?since=${encodeURIComponent(String(since))}`, {
        cache: 'no-store',
        signal: options.signal,
        timeoutMs: CONTROL_API_TIMEOUTS.quick,
        validate: isLogs,
      })
    },

    saveConfig(payload, options = {}) {
      return post('/api/config', payload, options)
    },

    savePreference(autoStartVoice: boolean, options: ControlCallOptions = {}) {
      return post('/api/preference', { autoStartVoice }, options)
    },

    serviceAction(
      service: ControlService,
      action: ControlServiceAction,
      options: ControlCallOptions = {},
    ) {
      return post(`/api/service/${service}`, { action }, options)
    },

    switchMode(mode: 'draw' | 'chat', options: ControlCallOptions = {}) {
      return post('/api/mode', { mode }, options)
    },

    start(enableTunnel, options = {}) {
      return post('/api/start', { enableTunnel }, options)
    },

    stop(options: ControlCallOptions = {}) {
      return post('/api/stop', {}, options)
    },

    getDiagnostics(options: ControlCallOptions = {}) {
      return client.request<ControlDiagnostics>('/api/diagnostics', {
        cache: 'no-store',
        signal: options.signal,
        timeoutMs: CONTROL_API_TIMEOUTS.action,
        validate: isDiagnostics,
      })
    },
  }
}

export const controlApi = createControlApi()
