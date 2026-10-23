import { apiClient } from './client'
import { desktopRuntimeFetch } from '@/platform/desktop/runtime'
import { imageMediaSession } from '@/platform/imageMediaSession'
import { assertRuntimeTaskSession } from './runtimeTaskAuthority'
import { hasRuntimeTasks, type TaskRecord } from './runtimeTasks'

export const qwenModels = [
  { value: 'qwen-image-2.1-turbo', label: 'Qwen-Image 2.1 Turbo · 8 步' },
  { value: 'qwen-image-2.1', label: 'Qwen-Image 2.1 · 40 步' },
] as const
export interface QwenModelStatus { id: string; available: boolean; unavailableReason: string | null; licenseUrl: string; mossSpectrum?: boolean }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
export async function qwenStatus(signal: AbortSignal): Promise<QwenModelStatus[]> {
  const value = await apiClient.request<Record<string, unknown>>('/api/qwen/status', { signal, timeoutMs: 15_000, cachePolicy: 'bypass' })
  if (value.ok !== true || value.provider !== 'native' || !Array.isArray(value.models)) throw new Error('请在控制室启用原生后端并重启，再读取 Qwen 状态')
  const models = value.models.map((model): QwenModelStatus => {
    if (!object(model) || !qwenModels.some(item => item.value === model.id) || model.family !== 'qwen-image'
      || typeof model.available !== 'boolean' || !(model.unavailableReason === null || typeof model.unavailableReason === 'string')
      || typeof model.licenseUrl !== 'string' || !model.licenseUrl.startsWith('https://huggingface.co/Qwen/')) throw new Error('Qwen 模型信息无效，请更新并重启后端')
    return { id: String(model.id), available: model.available, unavailableReason: model.unavailableReason, licenseUrl: model.licenseUrl }
  })
  if (models.length !== qwenModels.length || new Set(models.map(model => model.id)).size !== models.length) throw new Error('Qwen 模型清单不完整')
  return models
}
export async function uploadQwenImage(blob: Blob, signal: AbortSignal): Promise<string> {
  const value = await apiClient.request<{ ok: true; name: string }>('/api/qwen/images/raw', {
    method: 'POST', body: blob, signal, headers: { 'Content-Type': 'application/octet-stream' }, timeoutMs: 60_000,
    validate: v => v.ok === true && typeof v.name === 'string' && !!v.name,
  })
  return value.name
}

export async function readQwenTaskInput(task: TaskRecord, index: number, signal: AbortSignal): Promise<Blob> {
  if (!hasRuntimeTasks() || task.kind !== 'qwen' || task.provider !== 'native' || task.input.family !== 'qwen-image'
    || !Number.isInteger(index) || index < 0 || index > 3) throw new Error('Qwen 输入来源无效')
  assertRuntimeTaskSession(task)
  const owner = imageMediaSession(), requestSignal = AbortSignal.any([signal, AbortSignal.timeout(60_000)])
  const response = await desktopRuntimeFetch(`/api/tasks/v1/${encodeURIComponent(task.taskId)}/inputs/${index}`, { signal: requestSignal, cache: 'no-store' })
  try {
    if (!response.ok) throw new Error('原任务输入尚未持久化或已不可用，请在任务中心核对')
    const mime = response.headers.get('X-Workspace-Media-Mime'), bytes = Number(response.headers.get('X-Workspace-Media-Total-Bytes'))
    if (!mime || !['image/png', 'image/jpeg', 'image/webp'].includes(mime) || !Number.isSafeInteger(bytes) || bytes <= 0 || bytes > 16 * 1024 * 1024
      || response.headers.get('X-Workspace-Media-Offset') !== '0') throw new Error('原任务输入信息无效')
    const blob = await response.blob()
    requestSignal.throwIfAborted()
    if (owner !== imageMediaSession() || blob.size !== bytes || blob.type.split(';')[0] !== mime) throw new Error('原任务输入来源已变化')
    return blob
  } finally { if (!response.bodyUsed) await response.body?.cancel().catch(() => {}) }
}
