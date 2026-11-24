import { apiClient, type ApiResponseObject } from './client.ts'
import { isLocalStudioHost } from '../utils/runtimeEnvironment.ts'

export interface InferenceSettings {
  engine: 'comfy' | 'native' | 'remote'
  videoEngine: 'comfy' | 'native'
  acceleration: 'native' | 'sage' | 'compiled-sage' | 'compiled-fused-sage'
  memoryPolicy: 'auto' | 'resident' | 'offload'
  adapterMemoryPolicy: 'resident' | 'offload'
  modelsRoot: string
  lorasRoot: string
  python: string
  adapterPython?: string | null
  worker: string
  remoteUrl: string
  remoteKey: string
  remoteServe: boolean
  remotePort: number
}
export interface InferenceSettingsResponse {
  ok: true
  active: InferenceSettings
  configured: InferenceSettings
  restartRequired: boolean
  environmentOverrides: string[]
  remoteListening: boolean
  remoteAddress?: string | null
  museRelayUrl?: string | null
}
export interface MuseRelayStatus {
  ok: true
  url: string
  laptopOnline: boolean
  lastSeenAt: number | null
  storage: {
    usedBytes: number
    maxBytes: number
    readyFiles: number
    transferringFiles: number
    oldestExpiresAt: number | null
  } | null
  capabilities: { voice: boolean; modelRead: boolean } | null
}

export interface InferenceDiagnostics {
  basis: 'configured'
  configuration: 'valid' | 'invalid'
  files: Record<'modelsRoot' | 'lorasRoot' | 'python' | 'worker', boolean>
  dependencies: 'unchecked'
  runtime: 'unverified'
  message: string
}
export interface InferenceStatusResponse extends InferenceSettingsResponse {
  diagnostics: InferenceDiagnostics
  discovery: InferenceDiscovery
}
export interface InferenceDiscovery {
  suggested: InferenceSettings
  canAdopt: boolean
  modelCount: number
  loraCount: number
  missing: string[]
  runtimeReceipt: string | null
  preservesSavedSettings: boolean
  scope: 'local-files-only'
}
export interface InferenceProbeResponse {
  ok: true
  basis: 'active'
  probe: { id: null; event: 'diagnostic'; valid: true; dependencies: Record<string, string>; cudaAvailable: boolean; deviceName: string | null; backend?: 'cuda' | 'rocm' | 'xpu'; scope: string }
}
export interface InferenceSettingsApi {
  diagnose(signal?: AbortSignal): Promise<InferenceProbeResponse>
  getStatus(signal?: AbortSignal): Promise<InferenceStatusResponse>
  save(settings: InferenceSettings, signal?: AbortSignal): Promise<InferenceSettingsResponse>
}
export const inferenceSettingKeys = ['engine', 'videoEngine', 'acceleration', 'memoryPolicy', 'adapterMemoryPolicy', 'modelsRoot', 'lorasRoot', 'python', 'adapterPython', 'worker', 'remoteUrl', 'remoteKey', 'remoteServe', 'remotePort'] as const
const object = (value: unknown): value is ApiResponseObject => typeof value === 'object' && value !== null && !Array.isArray(value)
function settings(value: unknown): boolean {
  return object(value) && (value.engine === 'comfy' || value.engine === 'native' || value.engine === 'remote')
    && (value.videoEngine === 'comfy' || value.videoEngine === 'native')
    && typeof value.acceleration === 'string' && ['native', 'sage', 'compiled-sage', 'compiled-fused-sage'].includes(value.acceleration)
    && (value.memoryPolicy === 'auto' || value.memoryPolicy === 'resident' || value.memoryPolicy === 'offload')
    && (value.adapterMemoryPolicy === 'resident' || value.adapterMemoryPolicy === 'offload')
    && ['modelsRoot', 'lorasRoot', 'python', 'worker'].every(key => typeof value[key] === 'string')
    && (value.adapterPython == null || typeof value.adapterPython === 'string')
    && typeof value.remoteUrl === 'string' && typeof value.remoteKey === 'string'
    && typeof value.remoteServe === 'boolean' && Number.isInteger(value.remotePort)
}
function response(value: ApiResponseObject): boolean {
  return value.ok === true && settings(value.active) && settings(value.configured)
    && typeof value.restartRequired === 'boolean' && typeof value.remoteListening === 'boolean' && Array.isArray(value.environmentOverrides)
    && value.environmentOverrides.every(key => typeof key === 'string')
}
function status(value: ApiResponseObject): boolean {
  const diagnostics = value.diagnostics
  const discovery = value.discovery
  return response(value) && object(diagnostics) && diagnostics.basis === 'configured'
    && (value.remoteAddress == null || typeof value.remoteAddress === 'string')
    && (value.museRelayUrl == null || typeof value.museRelayUrl === 'string')
    && ['valid', 'invalid'].includes(String(diagnostics.configuration))
    && object(diagnostics.files) && ['modelsRoot', 'lorasRoot', 'python', 'worker'].every(key => typeof (diagnostics.files as ApiResponseObject)[key] === 'boolean')
    && diagnostics.dependencies === 'unchecked' && diagnostics.runtime === 'unverified' && typeof diagnostics.message === 'string'
    && object(discovery) && settings(discovery.suggested) && typeof discovery.canAdopt === 'boolean'
    && Number.isSafeInteger(discovery.modelCount) && Number(discovery.modelCount) >= 0
    && Number.isSafeInteger(discovery.loraCount) && Number(discovery.loraCount) >= 0
    && Array.isArray(discovery.missing) && discovery.missing.every(item => typeof item === 'string')
    && (discovery.runtimeReceipt === null || typeof discovery.runtimeReceipt === 'string')
    && typeof discovery.preservesSavedSettings === 'boolean' && discovery.scope === 'local-files-only'
}
function localOnly() { if (!isLocalStudioHost()) throw new Error('推理引擎设置仅限本机访问') }
export async function readMuseToken(signal: AbortSignal) {
  localOnly()
  return apiClient.request<{ ok: true; url: string; token: string }>('/api/inference/muse-token', {
    method: 'POST', signal, cache: 'no-store', cachePolicy: 'bypass',
    validate: value => value.ok === true && typeof value.url === 'string' && typeof value.token === 'string' && /^[a-f0-9]{64}$/i.test(value.token),
  })
}
const unsignedInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
export async function readMuseRelayStatus(signal: AbortSignal) {
  localOnly()
  return apiClient.request<MuseRelayStatus>('/api/control/muse-relay/status', {
    signal, timeoutMs: 12_000, cache: 'no-store', cachePolicy: 'bypass',
    validate(value) {
      const { storage, capabilities } = value
      return value.ok === true && typeof value.url === 'string' && typeof value.laptopOnline === 'boolean'
        && (value.lastSeenAt === null || unsignedInteger(value.lastSeenAt))
        && (storage === null || object(storage) && unsignedInteger(storage.usedBytes)
          && unsignedInteger(storage.maxBytes) && storage.maxBytes > 0
          && unsignedInteger(storage.readyFiles) && unsignedInteger(storage.transferringFiles)
          && (storage.oldestExpiresAt === null || unsignedInteger(storage.oldestExpiresAt)))
        && (capabilities === null || object(capabilities)
          && typeof capabilities.voice === 'boolean' && typeof capabilities.modelRead === 'boolean')
    },
  })
}

export const inferenceSettingsApi: InferenceSettingsApi = {
  async diagnose(signal) {
    localOnly()
    return apiClient.request<InferenceProbeResponse>('/api/inference/diagnostics', {
      method: 'POST', signal, timeoutMs: 35_000,
      validate(value) {
        const probe = value.probe
        return value.ok === true && value.basis === 'active' && object(probe)
          && probe.id === null && probe.event === 'diagnostic' && probe.valid === true
          && object(probe.dependencies) && Object.values(probe.dependencies).every(version => typeof version === 'string')
          && typeof probe.cudaAvailable === 'boolean' && (probe.deviceName === null || typeof probe.deviceName === 'string')
          && (probe.backend === undefined || probe.backend === 'cuda' || probe.backend === 'rocm' || probe.backend === 'xpu')
          && typeof probe.scope === 'string'
      },
    })
  },
  async getStatus(signal) {
    localOnly()
    return apiClient.request<InferenceStatusResponse>('/api/inference/status', {
      signal, timeoutMs: 10_000, cache: 'no-store', cachePolicy: 'bypass', validate: status,
    })
  },
  async save(body, signal) {
    localOnly()
    return apiClient.request<InferenceSettingsResponse>('/api/inference/settings', {
      method: 'POST', body: { ...body, ...(body.adapterPython === undefined ? {} : { adapterPython: body.adapterPython?.trim() || null }) }, signal, timeoutMs: 10_000, validate: response,
    })
  },
}
