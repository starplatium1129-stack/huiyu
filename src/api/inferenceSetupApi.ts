import { apiClient, type ApiClient, type ApiResponseObject } from './client'
import type { InferenceSettings } from './inferenceSettingsApi'
import type { ControlOperationView } from '@/types/api'
import { isLocalStudioHost } from '@/utils/runtimeEnvironment'
import catalog from '../../runtime-rs/src/control/setup-models.json'

export type PreparedInferencePaths = Omit<InferenceSettings, 'engine'>
export interface RuntimePreparationInput { basePython: string; wheelhouse: string; workspacePath: string; reviewed: true }
export interface ModelInspectionInput { modelId: string; sourceDir: string }
export interface ModelImportInput extends ModelInspectionInput { modelsRoot: string; reviewed: true }
export interface InferenceSetupOperation extends ControlOperationView {
  kind: 'prepare-inference-runtime' | 'import-inference-model'
  preparedPaths?: PreparedInferencePaths
  basePython?: string
  wheelhouse?: string
  workspacePath?: string
  modelId?: string
  sourceDir?: string
  modelsRoot?: string
  targetDir?: string
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
  prepareRuntime(input: RuntimePreparationInput): Promise<InferenceSetupResult>
  inspectModel(input: ModelInspectionInput, signal?: AbortSignal): Promise<InferenceModelInspection>
  importModel(input: ModelImportInput): Promise<InferenceSetupResult>
}
export const inferenceImportModels = catalog.files.filter(file => file.kind === 'image' && file.id.startsWith('anima-'))
  .map(file => ({ value: file.id, label: file.label || file.id }))
const modelIds = new Set(inferenceImportModels.map(model => model.value))
const object = (value: unknown): value is ApiResponseObject => typeof value === 'object' && value !== null && !Array.isArray(value)
const nonempty = (value: unknown): value is string => typeof value === 'string' && !!value.trim()
export function isPreparedInferencePaths(value: unknown): value is PreparedInferencePaths {
  return object(value) && ['python', 'worker', 'modelsRoot', 'lorasRoot'].every(key => nonempty(value[key]))
}
export function isInferenceSetupOperation(value: unknown): value is InferenceSetupOperation {
  return object(value) && nonempty(value.id)
    && ['prepare-inference-runtime', 'import-inference-model'].includes(String(value.kind))
    && ['running', 'completed', 'failed'].includes(String(value.status))
    && typeof value.message === 'string' && typeof value.error === 'string'
    && typeof value.startedAt === 'number' && Number.isFinite(value.startedAt)
    && (value.preparedPaths === undefined || isPreparedInferencePaths(value.preparedPaths))
}
export function createInferenceSetupApi(client: ApiClient = apiClient): InferenceSetupApi {
  function localOnly() { if (!isLocalStudioHost()) throw new Error('独立引擎准备仅限本机访问') }
  function knownModel(modelId: string) { if (!modelIds.has(modelId)) throw new Error('请选择已登记的 Anima 模型') }
  return {
    async prepareRuntime(body) {
      localOnly()
      if (body.reviewed !== true) throw new Error('请先确认可信 Python 与离线依赖来源')
      return client.request<InferenceSetupResult>('/api/inference/runtime/prepare', {
        method: 'POST', body, timeoutMs: 15_000,
        validate: value => value.ok === true && isInferenceSetupOperation(value.operation)
          && value.operation.kind === 'prepare-inference-runtime' && isPreparedInferencePaths(value.preparedPaths),
      })
    },
    async inspectModel(body, signal) {
      localOnly(); knownModel(body.modelId)
      return client.request<InferenceModelInspection>('/api/inference/models/inspect', {
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
      return client.request<InferenceSetupResult>('/api/inference/models/import', {
        method: 'POST', body, timeoutMs: 15_000,
        validate: value => value.ok === true && isInferenceSetupOperation(value.operation) && value.operation.kind === 'import-inference-model',
      })
    },
  }
}
export const inferenceSetupApi = createInferenceSetupApi()
