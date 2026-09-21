export interface Live2DParameterInfo {
  id: string
  index: number
  minimum: number
  maximum: number
  defaultValue: number
  value: number
}
export interface Live2DParameterEnumeration {
  supported: boolean
  parameters: Live2DParameterInfo[]
  reason?: string
}
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' ? value as Record<string, unknown> : null
const indexed = (value: unknown): ArrayLike<unknown> | null =>
  Array.isArray(value) || ArrayBuffer.isView(value) && !(value instanceof DataView) ? value as unknown as ArrayLike<unknown> : null

/** Snapshot real Core arrays only. No parameter lookup: Cubism can synthesize missing IDs. */
export function enumerateModelParameters(core: unknown): Live2DParameterEnumeration {
  const unsupported = (reason: string): Live2DParameterEnumeration => ({ supported: false, parameters: [], reason })
  try {
    const wrapper = object(core)
    if (!wrapper) return unsupported('当前后端未提供参数枚举。')
    const model = typeof wrapper.getModel === 'function' ? object(wrapper.getModel()) : object(wrapper._model) || wrapper
    const source = object(model?.parameters)
    if (!source) return unsupported('当前 SDK 未公开实际参数数组。')
    const ids = indexed(source.ids)
    const min = indexed(source.minimumValues)
    const max = indexed(source.maximumValues)
    const defaults = indexed(source.defaultValues)
    const values = indexed(source.values)
    if (!ids || !min || !max || !defaults || !values || ids.length > 4096
      || [min, max, defaults, values].some(items => items.length !== ids.length)
      || (source.count !== undefined && source.count !== ids.length)) return unsupported('SDK 参数数组缺失或数量不一致。')
    const parameters: Live2DParameterInfo[] = []
    const seen = new Set<string>()
    for (let index = 0; index < ids.length; index++) {
      const id = ids[index]
      const minimum = min[index], maximum = max[index], defaultValue = defaults[index], value = values[index]
      if (typeof id !== 'string' || !id || id.length > 256 || /[\u0000-\u001f]/.test(id) || seen.has(id)
        || typeof minimum !== 'number' || typeof maximum !== 'number' || typeof defaultValue !== 'number' || typeof value !== 'number'
        || ![minimum, maximum, defaultValue, value].every(Number.isFinite)
        || minimum > maximum || defaultValue < minimum || defaultValue > maximum) return unsupported('SDK 返回了无效 ID、范围或数值；未生成校准候选。')
      seen.add(id)
      parameters.push({ id, index, minimum, maximum, defaultValue, value })
    }
    return { supported: true, parameters }
  } catch { return unsupported('读取 SDK 参数失败；请重新加载模型。') }
}
