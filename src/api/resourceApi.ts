import { apiClient, type ApiClient, type ApiResponseObject } from './client'
import type { ResourceAction, ResourceStatus, ResourceTaskResult } from '../../types/resources'

export interface ResourceApi {
  status(fresh?: boolean, signal?: AbortSignal): Promise<ResourceStatus>
  start(action: ResourceAction, releaseId?: string, signal?: AbortSignal): Promise<ResourceTaskResult>
  cancel(taskId: string, signal?: AbortSignal): Promise<ResourceTaskResult>
}
const actions = ['import', 'download', 'recover', 'rollback']
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0
const issue = (value: unknown) => value === null || (object(value) && typeof value.code === 'string' && typeof value.message === 'string')
function task(value: unknown): boolean {
  return object(value) && typeof value.id === 'string' && /^[a-f\d-]{36}$/.test(value.id)
    && actions.includes(String(value.action)) && (value.releaseId === null || typeof value.releaseId === 'string')
    && [null, 'download', 'import'].includes(value.resumeAction as null | string)
    && ['running', 'cancelling', 'completed', 'failed', 'cancelled', 'interrupted'].includes(String(value.state))
    && typeof value.phase === 'string' && count(value.bytes) && count(value.total)
    && count(value.startedAt) && count(value.finishedAt) && issue(value.error)
}
function status(value: ApiResponseObject): boolean {
  return value.ok === true && ['configured', 'managementEnabled', 'busy', 'mounted', 'canRollback', 'recoveryRequired']
    .every(key => typeof value[key] === 'boolean')
    && (value.current === null || (object(value.current) && /^[a-f\d]{64}$/.test(String(value.current.identity))
      && typeof value.current.releaseId === 'string' && count(value.current.files)))
    && issue(value.issue) && (value.task === null || task(value.task))
    && Array.isArray(value.releases) && value.releases.every(item => object(item)
      && typeof item.id === 'string' && /^[\w-]{1,64}$/.test(item.id) && typeof item.label === 'string'
      && ['full', 'delta'].includes(String(item.kind)) && ['offline', 'http'].includes(String(item.source))
      && /^[a-f\d]{64}$/.test(String(item.identity)) && typeof item.downloaded === 'boolean')
}
export function createResourceApi(client: ApiClient = apiClient): ResourceApi {
  const common = { cache: 'no-store', cachePolicy: 'bypass', timeoutMs: 30_000 } as const
  return {
    status(fresh = false, signal) {
      return client.request<ResourceStatus>('/api/resources/status' + (fresh ? '?refresh=1' : ''), { ...common, signal, validate: status })
    },
    start(action, releaseId, signal) {
      return client.request<ResourceTaskResult>('/api/resources/tasks', { ...common, method: 'POST', signal,
        body: { action, ...(['import', 'download'].includes(action) ? { releaseId } : {}) },
        validate: value => value.ok === true && task(value.task) })
    },
    cancel(taskId, signal) {
      return client.request<ResourceTaskResult>(`/api/resources/tasks/${encodeURIComponent(taskId)}/cancel`, {
        ...common, method: 'POST', body: {}, signal, validate: value => value.ok === true && task(value.task),
      })
    },
  }
}
export const resourceApi = createResourceApi()
