import type { ArtworkRecord } from '@/types/artwork'
const fields: Array<{ key: string; label: string }> = [
  { key: 'engine', label: '引擎' }, { key: 'model', label: '底模' }, { key: 'size', label: '尺寸' }, { key: 'seed', label: '种子' },
  { key: 'steps', label: '步数' }, { key: 'cfg', label: 'CFG' }, { key: 'sampler', label: '采样器' }, { key: 'scheduler', label: '调度器' },
  { key: 'loraId', label: '角色 LoRA' }, { key: 'loraStrength', label: 'LoRA 强度' }, { key: 'styleLoraId', label: '风格 LoRA' },
  { key: 'hiresFix', label: '高清修复' }, { key: 'hiresScale', label: '修复倍率' }, { key: 'hiresDenoise', label: '修复重绘' },
  { key: 'prompt', label: 'Prompt' }, { key: 'negative', label: '负向' },
]
function value(item: ArtworkRecord, key: string) {
  const raw = key === 'model' ? item.model ?? item.checkpoint : item[key]
  return raw === undefined || raw === null ? '未记录' : typeof raw === 'boolean' ? raw ? '开启' : '关闭' : String(raw) || '空'
}
export function candidateParameterRows(items: readonly ArtworkRecord[], onlyDifferent: boolean) {
  return fields.map(field => ({ ...field, values: items.map(item => value(item, field.key)) }))
    .filter(row => row.values.some(value => value !== '未记录') && (!onlyDifferent || new Set(row.values).size > 1))
}
