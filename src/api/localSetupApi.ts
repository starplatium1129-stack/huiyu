import { apiClient, type ApiClient, type ApiResponseObject } from './client.ts'
import { isLocalStudioHost } from '../utils/runtimeEnvironment.ts'
import type { LocalSetupResponse } from '../../types/local-setup.ts'

const requiredModelIds = ['anima-aesthetic-v1.1', 'qwen-encoder', 'qwen-vae'] as const
const object = (value: unknown): value is ApiResponseObject => typeof value === 'object' && value !== null && !Array.isArray(value)
const fileState = (value: unknown) => value === 'present' || value === 'missing' || value === 'unknown'
const bytes = (value: unknown) => value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string')

function validSetup(value: ApiResponseObject): boolean {
  const { workspace, comfy, models, nodes, hardware } = value
  return value.ok === true && typeof value.checkedAt === 'number' && Number.isFinite(value.checkedAt) && value.checkedAt >= 0
    && object(workspace) && typeof workspace.path === 'string' && fileState(workspace.state)
    && object(comfy) && typeof comfy.path === 'string' && fileState(comfy.installation)
    && (comfy.layout === 'venv' || comfy.layout === 'portable' || comfy.layout === 'unrecognized')
    && typeof comfy.host === 'string' && (comfy.connection === 'online' || comfy.connection === 'offline' || comfy.connection === 'unknown')
    && Array.isArray(models) && models.every(model => object(model) && typeof model.id === 'string'
      && typeof model.label === 'string' && typeof model.path === 'string' && fileState(model.state)
      && bytes(model.bytes) && typeof model.required === 'boolean')
    && new Set(models.map(model => model.id)).size === models.length
    && requiredModelIds.every(id => models.some(model => model.id === id && model.required === true))
    && object(nodes) && (nodes.state === 'checked' || nodes.state === 'unknown')
    && strings(nodes.required) && strings(nodes.missing)
    && object(hardware) && (hardware.state === 'reported' || hardware.state === 'unknown') && bytes(hardware.ramBytes)
    && Array.isArray(hardware.devices) && hardware.devices.every(device => object(device)
      && typeof device.name === 'string' && typeof device.type === 'string' && bytes(device.vramBytes))
}

export function createLocalSetupApi(client: ApiClient = apiClient) {
  return {
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
