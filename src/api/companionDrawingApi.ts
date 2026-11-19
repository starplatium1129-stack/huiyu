import { apiClient } from './client'
import { getDesktopRuntime } from '@/platform/desktop/runtime'

const base = '/api/tasks/v1/companion-draw'
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const batchStates = ['draft', 'running', 'paused', 'cancelling', 'cancelled', 'failed', 'succeeded']
const jobStates = ['pending', 'running', 'accepted', 'unknown', 'cancelled', 'failed', 'succeeded']

interface DrawingCatalog {
  items: Array<{ id: string; kind: string; title: string }>
  nextPage: number | null
  total: number
}

interface DrawingResult {
  taskId?: string
  imageId?: string
  historyId?: string | null
}

export interface CompanionBatchJob extends DrawingResult {
  id: string
  sceneTitle: string
  variant: number
  status: string
  modelId?: string | null
  width?: number | null
  height?: number | null
  seed?: number
  previousResult?: DrawingResult
  error?: string | null
}

export interface CompanionBatch {
  id: string
  state: string
  revision: number
  jobs: CompanionBatchJob[]
  error?: string
}

async function request<T extends object>(path: string, method: string, validate: (value: unknown) => boolean,
  signal?: AbortSignal, body?: Record<string, unknown>): Promise<T | null> {
  const epoch = getDesktopRuntime().bootstrap?.runtime?.workspace?.runtimeEpoch
  if (!epoch) throw new Error('私人工作区尚未连接')
  const reply = await apiClient.request<{ result: T | null; runtimeEpoch: string }>(base + path, {
    method, signal, body, cachePolicy: 'bypass',
    validate: value => value.ok === true && typeof value.runtimeEpoch === 'string' && validate(value.result),
  })
  if (epoch !== reply.runtimeEpoch || epoch !== getDesktopRuntime().bootstrap?.runtime?.workspace?.runtimeEpoch) {
    throw new Error('对话绘图所属工作区已变化，请回到原连接')
  }
  return reply.result
}

export async function searchDrawingCatalog(args: Record<string, unknown>, signal: AbortSignal) {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== 'string' && !(typeof value === 'number' && Number.isSafeInteger(value))) {
      throw new Error('素材查询参数须为文字或整数')
    }
    query.set(key, String(value))
  }
  return request<DrawingCatalog>('/catalog?' + query.toString(), 'GET', value => object(value)
    && Array.isArray(value.items) && value.items.every(item => object(item)
      && typeof item.id === 'string' && typeof item.kind === 'string' && typeof item.title === 'string')
    && Number.isSafeInteger(value.total) && (value.nextPage === null || Number.isSafeInteger(value.nextPage)), signal)
}

export function companionDrawingBatch(id: string, method: 'GET' | 'POST' | 'DELETE' | 'PATCH', signal?: AbortSignal,
  input?: Record<string, unknown>) {
  return request<CompanionBatch>('/' + encodeURIComponent(id), method, value => value === null || validBatch(value, id), signal, input)
}

function validBatch(value: unknown, id: string): boolean {
  return object(value) && value.id === id && typeof value.state === 'string' && batchStates.includes(value.state)
    && Number.isSafeInteger(value.revision)
    && Array.isArray(value.jobs) && value.jobs.length <= 16
    && value.jobs.every(job => object(job) && typeof job.id === 'string' && typeof job.sceneTitle === 'string' && Number.isSafeInteger(job.variant)
      && typeof job.status === 'string' && jobStates.includes(job.status) && (job.status !== 'succeeded' || typeof job.taskId === 'string'
        && /^[\w-]{1,160}$/.test(job.taskId) && typeof job.imageId === 'string'
        && (job.historyId === undefined || typeof job.historyId === 'string'))
      && (job.previousResult === undefined || object(job.previousResult) && typeof job.previousResult.taskId === 'string'
        && typeof job.previousResult.imageId === 'string'
        && (job.previousResult.historyId == null || typeof job.previousResult.historyId === 'string'))
      && (job.modelId == null || typeof job.modelId === 'string')
      && [job.width, job.height, job.seed].every(field => field == null || Number.isSafeInteger(field))
      && (job.error == null || typeof job.error === 'string'))
    && (value.error == null || typeof value.error === 'string')
}

export function readCompanionDrawingPrompt(id: string, index: number, signal: AbortSignal) {
  return request<{ prompt: string; revision: number }>(`/${encodeURIComponent(id)}/${index}`, 'GET',
    value => object(value) && typeof value.prompt === 'string' && Number.isSafeInteger(value.revision), signal)
}

export function changeCompanionDrawingItem(id: string, index: number,
  input: { operation: 'edit' | 'rerun'; expectedRevision: number; prompt?: string }, signal: AbortSignal) {
  return request<CompanionBatch>(`/${encodeURIComponent(id)}/${index}`, 'PATCH', value => validBatch(value, id), signal, input)
}
