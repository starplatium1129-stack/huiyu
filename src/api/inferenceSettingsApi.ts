import { apiClient, type ApiClient, type ApiResponseObject } from './client.ts'
import { isLocalStudioHost } from '../utils/runtimeEnvironment.ts'

export interface InferenceSettings {
  engine: 'comfy' | 'native'
  modelsRoot: string
  lorasRoot: string
  python: string
  worker: string
}
export interface InferenceSettingsResponse {
  ok: true
  active: InferenceSettings
  configured: InferenceSettings
  restartRequired: boolean
  environmentOverrides: string[]
}
export interface InferenceDiagnostics {
  basis: 'configured'
  configuration: 'valid' | 'invalid'
  files: Record<Exclude<keyof InferenceSettings, 'engine'>, boolean>
  dependencies: 'unchecked'
  runtime: 'unverified'
  message: string
}
export interface InferenceStatusResponse extends InferenceSettingsResponse {
  diagnostics: InferenceDiagnostics
}
export interface InferenceProbeResponse {
  ok: true
  basis: 'active'
  probe: { id: null; event: 'diagnostic'; valid: true; dependencies: Record<string, string>; cudaAvailable: boolean; deviceName: string | null; scope: string }
}
export interface InferenceSettingsApi {
  diagnose(signal?: AbortSignal): Promise<InferenceProbeResponse>
  getStatus(signal?: AbortSignal): Promise<InferenceStatusResponse>
  save(settings: InferenceSettings, signal?: AbortSignal): Promise<InferenceSettingsResponse>
}
export const inferenceSettingKeys = ['engine', 'modelsRoot', 'lorasRoot', 'python', 'worker'] as const
const object = (value: unknown): value is ApiResponseObject => typeof value === 'object' && value !== null && !Array.isArray(value)
function settings(value: unknown): boolean {
  return object(value) && (value.engine === 'comfy' || value.engine === 'native')
    && ['modelsRoot', 'lorasRoot', 'python', 'worker'].every(key => typeof value[key] === 'string')
}
function response(value: ApiResponseObject): boolean {
  return value.ok === true && settings(value.active) && settings(value.configured)
    && typeof value.restartRequired === 'boolean' && Array.isArray(value.environmentOverrides)
    && value.environmentOverrides.every(key => typeof key === 'string')
}
function status(value: ApiResponseObject): boolean {
  const diagnostics = value.diagnostics
  return response(value) && object(diagnostics) && diagnostics.basis === 'configured'
    && ['valid', 'invalid'].includes(String(diagnostics.configuration))
    && object(diagnostics.files) && ['modelsRoot', 'lorasRoot', 'python', 'worker'].every(key => typeof (diagnostics.files as ApiResponseObject)[key] === 'boolean')
    && diagnostics.dependencies === 'unchecked' && diagnostics.runtime === 'unverified' && typeof diagnostics.message === 'string'
}
export function createInferenceSettingsApi(client: ApiClient = apiClient): InferenceSettingsApi {
  function localOnly() { if (!isLocalStudioHost()) throw new Error('推理引擎设置仅限本机访问') }
  return {
    async diagnose(signal) {
      localOnly()
      return client.request<InferenceProbeResponse>('/api/inference/diagnostics', {
        method: 'POST', signal, timeoutMs: 35_000,
        validate(value) {
          const probe = value.probe
          return value.ok === true && value.basis === 'active' && object(probe)
            && probe.id === null && probe.event === 'diagnostic' && probe.valid === true
            && object(probe.dependencies) && Object.values(probe.dependencies).every(version => typeof version === 'string')
            && typeof probe.cudaAvailable === 'boolean' && (probe.deviceName === null || typeof probe.deviceName === 'string')
            && typeof probe.scope === 'string'
        },
      })
    },
    async getStatus(signal) {
      localOnly()
      return client.request<InferenceStatusResponse>('/api/inference/status', {
        signal, timeoutMs: 10_000, cache: 'no-store', cachePolicy: 'bypass', validate: status,
      })
    },
    async save(body, signal) {
      localOnly()
      return client.request<InferenceSettingsResponse>('/api/inference/settings', {
        method: 'POST', body, signal, timeoutMs: 10_000, validate: response,
      })
    },
  }
}
export const inferenceSettingsApi = createInferenceSettingsApi()
