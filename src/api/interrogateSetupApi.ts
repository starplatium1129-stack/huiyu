import { apiClient, type ApiResponseObject } from './client'
import type { ControlOperationView } from '@/types/api'
import { isLocalStudioHost } from '@/utils/runtimeEnvironment'

export interface InterrogateSetupPlan {
  ok: true
  planId: string
  workspacePath: string
  paths: { runtimeRoot: string; modelRoot: string; depsRoot: string; cacheRoot: string }
  supported: boolean
  reasons: string[]
  freeBytes: number | null
  requiredBytes: number
  downloadBytes: number
  ready: boolean
  runtime: { id: string; label: string; installed: boolean; downloadBytes: number; requiredBytes: number }
  model: { id: 'pixai-tagger-v1.0'; label: string; revision: string; installed: boolean; downloadBytes: number }
  sources: { label: string; url: string; licenseUrl?: string }[]
}
export interface InterrogateSetupInput { workspacePath: string; planId: string; reviewed: true }
export interface InterrogateSetupOperation extends ControlOperationView {
  kind: 'prepare-pixai'
  workspacePath: string
  planId: string
  downloadedBytes: number
  totalBytes: number
  cancelAllowed: boolean
  phase?: string
  currentFile?: string
}
interface OperationEnvelope { ok: true; operation: ControlOperationView | null }
const object = (value: unknown): value is ApiResponseObject => typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim()
const bytes = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string')
function secureUrl(value: unknown): boolean {
  if (!text(value)) return false
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password }
  catch { return false }
}
function validPlan(value: ApiResponseObject): boolean {
  const { paths, runtime, model, sources } = value
  return value.ok === true && text(value.planId) && text(value.workspacePath)
    && object(paths) && ['runtimeRoot', 'modelRoot', 'depsRoot', 'cacheRoot'].every(key => text(paths[key]))
    && typeof value.supported === 'boolean' && strings(value.reasons)
    && (value.freeBytes === null || bytes(value.freeBytes)) && bytes(value.requiredBytes) && bytes(value.downloadBytes)
    && typeof value.ready === 'boolean' && object(runtime) && text(runtime.id) && text(runtime.label)
    && typeof runtime.installed === 'boolean' && bytes(runtime.downloadBytes) && bytes(runtime.requiredBytes)
    && object(model) && model.id === 'pixai-tagger-v1.0' && text(model.label) && text(model.revision)
    && typeof model.installed === 'boolean' && bytes(model.downloadBytes)
    && Array.isArray(sources) && sources.every(source => object(source) && text(source.label)
      && secureUrl(source.url) && (source.licenseUrl === undefined || secureUrl(source.licenseUrl)))
}
function validOperation(value: unknown): value is ControlOperationView {
  return object(value) && text(value.id) && text(value.kind) && text(value.label)
    && ['running', 'completed', 'failed'].includes(String(value.status))
    && typeof value.message === 'string' && typeof value.error === 'string'
    && bytes(value.startedAt) && bytes(value.finishedAt) && bytes(value.stageIndex) && strings(value.stages)
}
export function isInterrogateSetupOperation(value: unknown): value is InterrogateSetupOperation {
  return validOperation(value) && object(value) && value.kind === 'prepare-pixai'
    && text(value.workspacePath) && text(value.planId) && bytes(value.downloadedBytes) && bytes(value.totalBytes)
    && typeof value.cancelAllowed === 'boolean' && (value.phase === undefined || typeof value.phase === 'string')
    && (value.currentFile === undefined || typeof value.currentFile === 'string')
}
function localOnly() { if (!isLocalStudioHost()) throw new Error('图片反推准备仅限本机使用') }

export const interrogateSetupApi = {
  getPlan(signal?: AbortSignal): Promise<InterrogateSetupPlan> {
    localOnly()
    return apiClient.request<InterrogateSetupPlan>('/api/interrogate/setup/plan', {
      signal, cache: 'no-store', cachePolicy: 'bypass', timeoutMs: 20_000, validate: validPlan,
    })
  },
  prepare(input: InterrogateSetupInput, signal?: AbortSignal): Promise<{ ok: true; operation: InterrogateSetupOperation }> {
    localOnly()
    if (!text(input.workspacePath) || !text(input.planId) || input.reviewed !== true) throw new Error('请先读取当前准备计划')
    return apiClient.request<{ ok: true; operation: InterrogateSetupOperation }>('/api/interrogate/setup/prepare', {
      method: 'POST', body: input, signal, timeoutMs: 15_000,
      validate: value => value.ok === true && isInterrogateSetupOperation(value.operation)
        && value.operation.workspacePath === input.workspacePath && value.operation.planId === input.planId,
    })
  },
  getOperation(signal?: AbortSignal): Promise<OperationEnvelope> {
    localOnly()
    return apiClient.request<OperationEnvelope>('/api/local-setup/operation', {
      signal, cache: 'no-store', cachePolicy: 'bypass', timeoutMs: 10_000,
      validate: value => value.ok === true && (value.operation === null || validOperation(value.operation)
        && (value.operation.kind !== 'prepare-pixai' || isInterrogateSetupOperation(value.operation))),
    })
  },
  cancel(operationId: string, signal?: AbortSignal): Promise<{ ok: true }> {
    localOnly()
    if (!text(operationId)) throw new Error('准备操作尚未确认')
    return apiClient.request<{ ok: true }>('/api/local-setup/environment-cancel', {
      method: 'POST', body: { operationId }, signal, timeoutMs: 15_000, validate: value => value.ok === true,
    })
  },
}
