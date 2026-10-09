// ── popular/blueprint 数据严格解析守卫 ─────────────────────────────────────
// 2026-09-05 从 popularContent.ts 抽出（单体门禁 604>600 拆分）。
// 纯函数、零依赖；popularContent 与任何需要同款 JSON 守卫的模块共用。

import type { BlueprintCompositionIntent } from '../types/sceneBlueprint'

export function parseCompositionIntent(value: unknown): BlueprintCompositionIntent {
  if (value == null || value === '') return 'single'
  if (value === 'single' || value === 'group' || value === 'triptych') return value
  throw new Error('Invalid blueprint compositionIntent')
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/**
 * 负面词列表解析：兼容字符串与数组两种数据格式。
 * scene-blueprints.json 的 negativeTokens 历史格式为逗号分隔字符串
 * （"worst quality, low quality, ..."），stringList 对字符串返回 [] 会静默丢词
 * （2026-08-15 发现：336 个场景的场景级负面定制从未生效）。
 */
export function negativeStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    // 2026-08-15 审计：兼容历史「单元素数组内整段逗号串」格式（162/336 蓝图）。
    // 任何数组元素都按逗号切分，保证按元素消费（includes/去重/UI chips）不踩坑。
    return value.flatMap(item => typeof item === 'string'
      ? item.split(',').map(segment => segment.trim()).filter(Boolean)
      : [])
  }
  if (typeof value === 'string' && value.trim()) {
    return value.split(',').map(item => item.trim()).filter(Boolean)
  }
  return []
}

export function requiredString(record: Record<string, unknown>, key: string): string {
  const value = stringValue(record[key])
  if (!value) throw new Error(`popular data: ${key} must be a non-empty string`)
  return value
}

export function requiredStringList(record: Record<string, unknown>, key: string): string[] {
  const value = stringList(record[key])
  if (!value.length) throw new Error(`popular data: ${key} must be a non-empty string array`)
  return value
}
