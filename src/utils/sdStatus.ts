export interface SDStatus {
  online: boolean
  checkpoint: string
  samplers: string[]
  models: string[]
  schedulers: string[]
  upscalers: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function optionName(value: unknown, fields: string[]): string {
  if (typeof value === 'string') return value.trim()
  if (!isRecord(value)) return ''
  for (const field of fields) {
    if (typeof value[field] === 'string' && value[field].trim()) return value[field].trim()
  }
  return ''
}

export function parseSDOptionList(value: unknown, fields: string[] = ['name']): string[] {
  return Array.isArray(value)
    ? value.map(item => optionName(item, fields)).filter(Boolean)
    : []
}

export function parseSDStatus(value: unknown): SDStatus {
  const status = isRecord(value) ? value : {}
  return {
    online: status.online === true,
    checkpoint: typeof status.checkpoint === 'string' ? status.checkpoint : '',
    models: parseSDOptionList(status.models, ['title', 'model_name', 'name']),
    samplers: parseSDOptionList(status.samplers),
    schedulers: parseSDOptionList(status.schedulers, ['name', 'label']),
    upscalers: parseSDOptionList(status.upscalers),
  }
}
