import { apiClient, type ApiClient, type ApiResponseObject, type FetchImplementation } from './client.ts'
import { verifyLocalSetupModel, type VerificationOptions } from './localSetupVerification.ts'
import { downloadLocalSetupModel, type DownloadOptions } from './localSetupDownload.ts'
import { isLocalStudioHost } from '../utils/runtimeEnvironment.ts'
import type { LocalSetupResponse } from '../../types/local-setup.ts'

const requiredModelIds = ['anima-aesthetic-v1.1', 'qwen-encoder', 'qwen-vae'] as const
const object = (value: unknown): value is ApiResponseObject => typeof value === 'object' && value !== null && !Array.isArray(value)
const fileState = (value: unknown) => value === 'present' || value === 'missing' || value === 'unknown'
const bytes = (value: unknown) => value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
const publisherUrl = (value: unknown) => {
  if (typeof value !== 'string') return false
  try { const url = new URL(value); return url.origin === 'https://huggingface.co' && !url.username && !url.password }
  catch { return false }
}
const preparation = (value: unknown) => value === null || (object(value)
  && publisherUrl(value.url) && publisherUrl(value.modelCardUrl) && publisherUrl(value.licenseUrl)
  && (value.upstreamLicenseUrl === null || publisherUrl(value.upstreamLicenseUrl))
  && typeof value.revision === 'string' && /^[a-f0-9]{40}$/.test(value.revision)
  && typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256)
  && typeof value.expectedBytes === 'number' && Number.isSafeInteger(value.expectedBytes) && value.expectedBytes > 0)
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string')

function validSetup(value: ApiResponseObject): boolean {
  const { workspace, comfy, models, nodes, hardware } = value
  return value.ok === true && typeof value.checkedAt === 'number' && Number.isFinite(value.checkedAt) && value.checkedAt >= 0
    && object(workspace) && typeof workspace.path === 'string' && fileState(workspace.state)
    && object(comfy) && typeof comfy.path === 'string' && fileState(comfy.installation)
    && (comfy.layout === 'venv' || comfy.layout === 'external-venv' || comfy.layout === 'portable' || comfy.layout === 'unrecognized')
    && typeof comfy.host === 'string' && (comfy.connection === 'online' || comfy.connection === 'offline' || comfy.connection === 'unknown')
    && Array.isArray(models) && models.every(model => object(model) && typeof model.id === 'string'
      && typeof model.label === 'string' && typeof model.path === 'string' && fileState(model.state)
      && bytes(model.bytes) && typeof model.required === 'boolean' && preparation(model.preparation)
      && (!model.required || model.preparation !== null))
    && new Set(models.map(model => model.id)).size === models.length
    && requiredModelIds.every(id => models.some(model => model.id === id && model.required === true))
    && object(nodes) && (nodes.state === 'checked' || nodes.state === 'unknown')
    && strings(nodes.required) && strings(nodes.missing)
    && object(hardware) && (hardware.state === 'reported' || hardware.state === 'unknown') && bytes(hardware.ramBytes)
    && Array.isArray(hardware.devices) && hardware.devices.every(device => object(device)
      && typeof device.name === 'string' && typeof device.type === 'string' && bytes(device.vramBytes))
}

export function createLocalSetupApi(client: ApiClient = apiClient, fetch?: FetchImplementation) {
  return {
    downloadModel: (modelId: string, options: DownloadOptions) => downloadLocalSetupModel(modelId, options, fetch),
    verifyModel: (modelId: string, options: VerificationOptions) => verifyLocalSetupModel(modelId, options, fetch),
    async getStatus(options: { signal?: AbortSignal } = {}): Promise<LocalSetupResponse> {
      if (!isLocalStudioHost()) throw new Error('首次配置检查仅限本机使用')
      return client.request<LocalSetupResponse>('/api/local-setup', {
        method: 'GET', cache: 'no-store', cachePolicy: 'bypass', signal: options.signal,
        timeoutMs: 15_000, validate: validSetup,
      })
    },
  }
}

export const localSetupApi = createLocalSetupApi()
