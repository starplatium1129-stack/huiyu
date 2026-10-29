import { apiClient, type ApiResponseObject } from './client'
import type { InferenceSettings } from './inferenceSettingsApi'
import type { ControlOperationView } from '@/types/api'
import { isLocalStudioHost } from '@/utils/runtimeEnvironment'
import catalog from '../../runtime-rs/src/control/setup-models.json'

export type PreparedInferencePaths = Pick<InferenceSettings, 'python' | 'worker' | 'modelsRoot' | 'lorasRoot'>
export interface RuntimePreparationInput { operationId?: string; basePython: string; wheelhouse: string; workspacePath: string; reviewed: true }
export interface ModelInspectionInput { modelId: string; sourceDir: string }
export interface ModelImportInput extends ModelInspectionInput { operationId?: string; modelsRoot: string; reviewed: true }
export interface ManagedInferenceInput { operationId?: string; workspacePath: string; planId: string; reviewed: true; modelId?: string; hfToken?: string; checkpointPath?: string; resourceRoot?: string }
export interface NativeImageResource {
  id: string; label: string; family: string; description: string; directory: 'models' | 'loras'; root: string
  licenseUrl: string; sourceUrl: string; downloadBytes: number; requiredBytes: number; present: boolean; path: string
  fileCount: number; freeBytes: number | null; prepareError: string
}
export interface NativeSetupPlan {
  ok: true
  planId: string
  selectedModelId: string
  workspacePath: string
  paths: { runtimeRoot: string; modelsRoot: string; lorasRoot: string; cacheRoot: string; tempRoot: string }
  hardware: { devices: { name: string; type?: string; vramBytes?: number | null; driverVersion?: string }[]; otherDevices?: { name: string; driverVersion: string | null }[]; ramBytes: number | null }
  supported: boolean
  reasons: string[]
  warnings?: string[]
  freeBytes: number | null
  runtime: { id: string; label: string; downloadBytes: number; requiredBytes: number; recoveryReady?: boolean; sources: { label: string; url: string; licenseUrl: string }[]; installed: boolean }
  models: { preparation?: 'checkpoint-conversion' | 'complete-model'; checkpointFilename?: string | null; checkpointOptional?: boolean; requiresAccess: boolean; family: string; id: string; label: string; revision: string; license: string; licenseUrl: string; sourceUrl: string; downloadBytes: number; requiredBytes: number; installed: boolean }[]
  resources: NativeImageResource[]
  activeEngine: string
  configuredEngine: string
  restartRequired: boolean
  workspaceMatches: boolean
  steps: { runtime: string; model: string; engine: string }
}
export interface NativeActivationResult { ok: true; restartRequired: boolean; active: { engine: 'native' | 'comfy' }; configured: { engine: 'native' } }
export interface InferenceSetupOperation extends ControlOperationView {
  interrupted?: boolean
  kind: 'prepare-inference-runtime' | 'import-inference-model' | 'install-native-runtime' | 'download-native-model' | 'download-native-resource' | 'prepare-native-engine'
  flowStep?: 'runtime' | 'model' | 'activate'
  preparedPaths?: PreparedInferencePaths
  basePython?: string
  wheelhouse?: string
  workspacePath?: string
  modelId?: string
  resourceRoot?: string
  sourceDir?: string
  modelsRoot?: string
  targetDir?: string
  planId?: string
  stage?: string
  phase?: string
  currentFile?: string
  downloadedBytes?: number
  totalBytes?: number
  cancelAllowed?: boolean
}
export interface InferenceSetupResult { ok: true; operation: InferenceSetupOperation; preparedPaths?: PreparedInferencePaths }
export interface InferenceModelInspection {
  ok: true
  planOnly: true
  sourceDir: string
  targetDir: string
  scope: 'layout-only'
  readyForInference: false
  fileCount: number
  totalBytes: number
}
export interface InferenceSetupApi {
  getPlan(signal?: AbortSignal, modelId?: string): Promise<NativeSetupPlan>
  prepareEngine(input: ManagedInferenceInput): Promise<InferenceSetupResult>
  installRuntime(input: ManagedInferenceInput): Promise<InferenceSetupResult>
  downloadModel(input: ManagedInferenceInput): Promise<InferenceSetupResult>
  downloadResource(input: ManagedInferenceInput): Promise<InferenceSetupResult>
  activate(input: ManagedInferenceInput, signal?: AbortSignal): Promise<NativeActivationResult>
  prepareRuntime(input: RuntimePreparationInput): Promise<InferenceSetupResult>
  inspectModel(input: ModelInspectionInput, signal?: AbortSignal): Promise<InferenceModelInspection>
  importModel(input: ModelImportInput): Promise<InferenceSetupResult>
}
export const inferenceImportModels = catalog.files.filter(file => file.kind === 'image' && file.id.startsWith('anima-'))
  .map(file => ({ value: file.id, label: file.label || file.id }))
const modelIds = new Set(inferenceImportModels.map(model => model.value))
const object = (value: unknown): value is ApiResponseObject => typeof value === 'object' && value !== null && !Array.isArray(value)
const nonempty = (value: unknown): value is string => typeof value === 'string' && !!value.trim()
const bytes = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0
const optionalBytes = (value: unknown) => value === undefined || value === null || bytes(value)
const secureUrl = (value: unknown) => {
  if (!nonempty(value)) return false
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password }
  catch { return false }
}
function validPlan(value: ApiResponseObject): boolean {
  const { paths, hardware, runtime, models, steps } = value
  return value.ok === true && nonempty(value.planId) && nonempty(value.selectedModelId) && nonempty(value.workspacePath)
    && Array.isArray(value.resources) && value.resources.every(entry => object(entry) && nonempty(entry.id) && nonempty(entry.label)
      && ['anima', 'krea2', 'manga'].includes(String(entry.family)) && secureUrl(entry.licenseUrl) && secureUrl(entry.sourceUrl)
      && ['models', 'loras'].includes(String(entry.directory)) && nonempty(entry.root) && nonempty(entry.description)
      && bytes(entry.fileCount) && entry.fileCount > 0 && (entry.freeBytes === null || bytes(entry.freeBytes)) && typeof entry.prepareError === 'string' && bytes(entry.downloadBytes)
      && bytes(entry.requiredBytes) && typeof entry.present === 'boolean' && nonempty(entry.path))
    && object(paths) && ['runtimeRoot', 'modelsRoot', 'lorasRoot', 'cacheRoot', 'tempRoot'].every(key => nonempty(paths[key]))
    && object(hardware) && (hardware.ramBytes === null || bytes(hardware.ramBytes))
    && Array.isArray(hardware.devices) && hardware.devices.every(device => object(device) && nonempty(device.name)
      && optionalBytes(device.vramBytes) && (device.type === undefined || typeof device.type === 'string')
      && (device.driverVersion === undefined || typeof device.driverVersion === 'string'))
    && (hardware.otherDevices === undefined || Array.isArray(hardware.otherDevices) && hardware.otherDevices.every(device => object(device)
      && nonempty(device.name) && (device.driverVersion === null || typeof device.driverVersion === 'string')))
    && typeof value.supported === 'boolean' && Array.isArray(value.reasons) && value.reasons.every(reason => typeof reason === 'string')
    && (value.warnings === undefined || Array.isArray(value.warnings) && value.warnings.every(warning => typeof warning === 'string'))
    && (value.freeBytes === null || bytes(value.freeBytes))
    && object(runtime) && nonempty(runtime.id) && nonempty(runtime.label) && bytes(runtime.downloadBytes) && bytes(runtime.requiredBytes)
    && (runtime.recoveryReady === undefined || typeof runtime.recoveryReady === 'boolean')
    && typeof runtime.installed === 'boolean' && Array.isArray(runtime.sources) && runtime.sources.every(source => object(source)
      && nonempty(source.label) && secureUrl(source.url) && secureUrl(source.licenseUrl))
    && Array.isArray(models) && models.length > 0 && models.every(model => object(model) && nonempty(model.id) && nonempty(model.label)
      && (model.checkpointOptional === undefined || typeof model.checkpointOptional === 'boolean')
      && (model.preparation === undefined || ['checkpoint-conversion', 'complete-model'].includes(String(model.preparation)))
      && (model.checkpointFilename === undefined || model.checkpointFilename === null || nonempty(model.checkpointFilename))
      && typeof model.requiresAccess === 'boolean' && ['anima', 'krea2', 'qwen-image', 'moss-image'].includes(String(model.family))
      && nonempty(model.revision) && nonempty(model.license) && secureUrl(model.licenseUrl) && secureUrl(model.sourceUrl)
      && bytes(model.downloadBytes) && bytes(model.requiredBytes) && typeof model.installed === 'boolean')
    && new Set(models.map(model => model.id)).size === models.length
    && ['native', 'comfy'].includes(String(value.activeEngine)) && ['native', 'comfy'].includes(String(value.configuredEngine))
    && typeof value.restartRequired === 'boolean' && typeof value.workspaceMatches === 'boolean'
    && object(steps) && ['runtime', 'model', 'engine'].every(key => typeof steps[key] === 'string')
}
export function isPreparedInferencePaths(value: unknown): value is PreparedInferencePaths {
  return object(value) && ['python', 'worker', 'modelsRoot', 'lorasRoot'].every(key => nonempty(value[key]))
}
export function isInferenceSetupOperation(value: unknown): value is InferenceSetupOperation {
  return object(value) && nonempty(value.id)
    && ['prepare-inference-runtime', 'import-inference-model', 'install-native-runtime', 'download-native-model', 'download-native-resource', 'prepare-native-engine'].includes(String(value.kind))
    && (value.flowStep === undefined || ['runtime', 'model', 'activate'].includes(String(value.flowStep)))
    && ['running', 'completed', 'failed'].includes(String(value.status))
    && typeof value.message === 'string' && typeof value.error === 'string'
    && typeof value.startedAt === 'number' && Number.isFinite(value.startedAt)
    && (value.preparedPaths === undefined || isPreparedInferencePaths(value.preparedPaths))
    && (value.workspacePath === undefined || nonempty(value.workspacePath))
    && (value.planId === undefined || nonempty(value.planId))
    && (value.resourceRoot === undefined || nonempty(value.resourceRoot))
    && (value.stage === undefined || typeof value.stage === 'string')
    && (value.stageIndex === undefined || bytes(value.stageIndex))
    && (value.downloadedBytes === undefined || bytes(value.downloadedBytes))
    && (value.totalBytes === undefined || bytes(value.totalBytes))
    && (value.cancelAllowed === undefined || typeof value.cancelAllowed === 'boolean')
    && (value.phase === undefined || typeof value.phase === 'string')
    && (value.currentFile === undefined || typeof value.currentFile === 'string')
}
function localOnly() { if (!isLocalStudioHost()) throw new Error('独立引擎准备仅限本机访问') }
function knownModel(modelId: string) { if (!modelIds.has(modelId)) throw new Error('请选择已登记的 Anima 模型') }
function reviewedPlan(body: ManagedInferenceInput) {
  localOnly()
  if (!body.reviewed || !nonempty(body.workspacePath) || !nonempty(body.planId)) throw new Error('请先核对当前工作区、下载清单与使用条件')
}
async function managedOperation(path: string, body: ManagedInferenceInput, kind: InferenceSetupOperation['kind']) {
  reviewedPlan(body)
  return apiClient.request<InferenceSetupResult>(path, {
    method: 'POST', body, timeoutMs: 15_000,
    validate: value => value.ok === true && isInferenceSetupOperation(value.operation)
      && value.operation.kind === kind && value.operation.workspacePath === body.workspacePath
      && value.operation.planId === body.planId && (body.modelId === undefined || value.operation.modelId === body.modelId)
      && (body.resourceRoot === undefined || value.operation.resourceRoot === body.resourceRoot),
  })
}
export const inferenceSetupApi: InferenceSetupApi = {
  async getPlan(signal, modelId) {
    localOnly()
    return apiClient.request<NativeSetupPlan>(`/api/inference/setup/plan${modelId ? `?modelId=${encodeURIComponent(modelId)}` : ''}`, {
      signal, timeoutMs: 20_000, cache: 'no-store', cachePolicy: 'bypass', validate: validPlan,
    })
  },
  prepareEngine: body => managedOperation('/api/inference/setup/prepare', body, 'prepare-native-engine'),
  installRuntime: body => managedOperation('/api/inference/runtime/install', body, 'install-native-runtime'),
  downloadModel: body => managedOperation('/api/inference/models/download', body, 'download-native-model'),
  downloadResource: body => managedOperation('/api/inference/resources/download', body, 'download-native-resource'),
  async activate(body, signal) {
    reviewedPlan(body)
    if (!nonempty(body.modelId)) throw new Error('请选择已完整校验的原生模型')
    return apiClient.request<NativeActivationResult>('/api/inference/setup/activate', {
      method: 'POST', body, signal, timeoutMs: 185_000,
      validate: value => value.ok === true && typeof value.restartRequired === 'boolean'
        && object(value.active) && ['native', 'comfy'].includes(String(value.active.engine))
        && object(value.configured) && value.configured.engine === 'native',
    })
  },
  async prepareRuntime(body) {
    localOnly()
    if (body.reviewed !== true) throw new Error('请先确认可信 Python 与离线依赖来源')
    return apiClient.request<InferenceSetupResult>('/api/inference/runtime/prepare', {
      method: 'POST', body, timeoutMs: 15_000,
      validate: value => value.ok === true && isInferenceSetupOperation(value.operation)
        && value.operation.kind === 'prepare-inference-runtime' && isPreparedInferencePaths(value.preparedPaths),
    })
  },
  async inspectModel(body, signal) {
    localOnly(); knownModel(body.modelId)
    return apiClient.request<InferenceModelInspection>('/api/inference/models/inspect', {
      method: 'POST', body, signal, timeoutMs: 125_000,
      validate: value => value.ok === true && value.planOnly === true && nonempty(value.sourceDir) && nonempty(value.targetDir)
        && value.scope === 'layout-only' && value.readyForInference === false
        && Number.isSafeInteger(value.fileCount) && Number(value.fileCount) > 0
        && Number.isSafeInteger(value.totalBytes) && Number(value.totalBytes) >= 0,
    })
  },
  async importModel(body) {
    localOnly(); knownModel(body.modelId)
    if (body.reviewed !== true) throw new Error('请先检查并确认模型复制计划')
    return apiClient.request<InferenceSetupResult>('/api/inference/models/import', {
      method: 'POST', body, timeoutMs: 15_000,
      validate: value => value.ok === true && isInferenceSetupOperation(value.operation) && value.operation.kind === 'import-inference-model',
    })
  },
}
