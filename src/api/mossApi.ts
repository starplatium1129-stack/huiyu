import { apiClient } from './client'
import type { QwenModelStatus } from './qwenApi'

export const MOSS_MODEL_ID = 'moss-miaomiao-base-v1.0'
export const mossModels = [{ value: MOSS_MODEL_ID, label: 'MiaoMiao Harem MOSS · BASE v1.0' }] as const

export async function mossStatus(signal: AbortSignal): Promise<QwenModelStatus[]> {
  const value = await apiClient.request<Record<string, unknown>>('/api/moss/status', { signal, timeoutMs: 15_000, cachePolicy: 'bypass' })
  if (value.ok !== true || value.provider !== 'native' || !Array.isArray(value.models)) throw new Error('请在控制室准备 MOSS 原生模型并重启')
  const model = value.models.find((item: unknown) => item && typeof item === 'object' && 'id' in item && item.id === MOSS_MODEL_ID)
  if (!model || model.family !== 'moss-image' || typeof model.available !== 'boolean'
    || !(model.unavailableReason === null || typeof model.unavailableReason === 'string')
    || model.licenseUrl !== 'https://civitai.com/models/3015023?modelVersionId=3422319') throw new Error('MOSS 模型信息无效，请更新并重启后端')
  const acceleration = model.mossAcceleration
  if (acceleration !== undefined && acceleration !== null && (!Array.isArray(acceleration)
    || acceleration.length !== 2 || acceleration[0] !== 'off' || acceleration[1] !== 'spectrum')) throw new Error('MOSS 加速选项无效，请更新并重启后端')
  return [{ id: MOSS_MODEL_ID, available: model.available, unavailableReason: model.unavailableReason,
    licenseUrl: model.licenseUrl, mossSpectrum: Array.isArray(acceleration) && acceleration.includes('spectrum') }]
}
