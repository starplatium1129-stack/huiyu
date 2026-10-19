import { apiClient } from './client'

export const qwenModels = [
  { value: 'qwen-image-2.1-turbo', label: 'Qwen-Image 2.1 Turbo · 8 步' },
  { value: 'qwen-image-2.1', label: 'Qwen-Image 2.1 · 40 步' },
] as const
export interface QwenModelStatus { id: string; available: boolean; unavailableReason: string | null; licenseUrl: string }
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
