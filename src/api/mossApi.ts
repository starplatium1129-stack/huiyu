import { apiClient } from './client'
import type { QwenModelStatus } from './qwenApi'

export const MOSS_MODEL_ID = 'moss-miaomiao-base-v1.1'
export const mossModels = [
  { value: MOSS_MODEL_ID, label: 'MiaoMiao Harem MOSS · BASE v1.1', versionId: '3434952' },
  { value: 'moss-miaomiao-base-v1.0', label: 'MiaoMiao Harem MOSS · BASE v1.0', versionId: '3422319' },
] as const
export const validMossSpectrumFlexWindow = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 2

export async function mossStatus(signal: AbortSignal): Promise<QwenModelStatus[]> {
  const value = await apiClient.request<Record<string, unknown>>('/api/moss/status', { signal, timeoutMs: 15_000, cachePolicy: 'bypass' })
  if (value.ok !== true || value.provider !== 'native' || !Array.isArray(value.models)) throw new Error('请在控制室准备 MOSS 原生模型并重启')
  const models = value.models
  return mossModels.map(selected => {
    const model = models.find((item: unknown) => item && typeof item === 'object' && 'id' in item && item.id === selected.value)
    if (!model) return { id: selected.value, available: false, unavailableReason: '后端未登记此版本，请更新并重启绘遇',
      licenseUrl: `https://civitai.com/models/3015023?modelVersionId=${selected.versionId}` }
    if (model.family !== 'moss-image' || typeof model.available !== 'boolean'
      || !(model.unavailableReason === null || typeof model.unavailableReason === 'string')
      || model.licenseUrl !== `https://civitai.com/models/3015023?modelVersionId=${selected.versionId}`) throw new Error('MOSS 模型信息无效，请更新并重启后端')
    const acceleration = model.mossAcceleration
    if (acceleration !== undefined && acceleration !== null && (!Array.isArray(acceleration)
      || acceleration.length !== 2 || acceleration[0] !== 'off' || acceleration[1] !== 'spectrum')) throw new Error('MOSS 加速选项无效，请更新并重启后端')
    const precision = model.mossTextPrecision
    if (model.mossRemacri !== undefined && typeof model.mossRemacri !== 'boolean') throw new Error('MOSS 超分能力无效，请更新并重启后端')
    if (model.mossSpectrumFlexWindow !== undefined && typeof model.mossSpectrumFlexWindow !== 'boolean') throw new Error('MOSS Spectrum 参数能力无效，请更新并重启后端')
    if (precision !== undefined && precision !== null && (!Array.isArray(precision)
      || !(precision.length === 2 || precision.length === 3) || precision[0] !== 'bf16' || precision[1] !== 'fp8'
      || precision.length === 3 && precision[2] !== 'int8')) throw new Error('MOSS 精度选项无效，请更新并重启后端')
    if (model.mossCompile !== undefined && model.mossCompile !== null && typeof model.mossCompile !== 'boolean') throw new Error('MOSS 编译选项无效，请更新并重启后端')
    if (model.mossFp16Ready !== undefined && typeof model.mossFp16Ready !== 'boolean') throw new Error('MOSS FP16 权重状态无效，请更新并重启后端')
    if (model.mossInt8Ready !== undefined && typeof model.mossInt8Ready !== 'boolean') throw new Error('MOSS 权重状态无效，请更新并重启后端')
    if (model.mossTextInt8Ready !== undefined && typeof model.mossTextInt8Ready !== 'boolean') throw new Error('MOSS 文本权重状态无效，请更新并重启后端')
    return { id: selected.value, available: model.available, unavailableReason: model.unavailableReason,
      licenseUrl: model.licenseUrl, mossSpectrum: Array.isArray(acceleration) && acceleration.includes('spectrum'), mossFlexWindow: model.mossSpectrumFlexWindow === true, mossRemacri: model.mossRemacri === true,
      mossFp8: Array.isArray(precision) && precision.includes('fp8'), mossCompile: model.mossCompile === true,
      mossFp16Ready: model.mossFp16Ready === true,
      mossInt8Ready: model.mossInt8Ready === true,
      mossTextInt8Ready: Array.isArray(precision) && precision.includes('int8') && model.mossTextInt8Ready === true }
  })
}
