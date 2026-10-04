import type { CatalogKind, CatalogRecord } from '@/api/catalogApi'
import { franchiseLabel } from '@/utils/franchiseLabel'
export const CATALOG_LABELS: Record<CatalogKind, string> = {
  character: '角色档案', outfit: '服装方案', scene: '场景故事', blueprint: '场景蓝图', document: '标签与推荐',
}
const DOCUMENT_TITLES: Record<string, string> = {
  tags: '创作用词', curation: '场景推荐', 'tag-dictionary-policy': '同义词与重复词规则',
  'prompt-pinned-scenes': '已确认的画面描述', 'retired-scenes': '已归档的场景', loras: '绘图资源',
}
export function catalogTitle(kind: CatalogKind, id: string, title = ''): string {
  return kind === 'document' ? DOCUMENT_TITLES[id] || '资料配置' : title || '未命名内容'
}
export function recordTitle(record: CatalogRecord): string {
  const data = record.data as Record<string, unknown>
  const profile = data.profile as Record<string, unknown> | undefined
  const popular = data.popular as Record<string, unknown> | undefined
  const outfit = data.outfit as Record<string, unknown> | undefined
  return catalogTitle(record.kind, record.id, String(data.title || popular?.displayName || profile?.name || outfit?.name || ''))
}
export function catalogRating(value: string): string {
  return ({ All: '全年龄', SFW: '全年龄', R15: '十五岁以上', R18: '成人内容' } as Record<string, string>)[value] || ''
}
export function catalogCategory(value: string): string {
  const known: Record<string, string> = { Core: '主线故事', custom: '自建内容', after_story: '后日谈', After_Story: '后日谈', daily: '日常', iconic: '经典场景', special_nsfw: '私密场景' }
  const label = (known[value] || franchiseLabel(value)).replace(/After_Story/gi, '后日谈').replaceAll('/', ' · ')
  return /[\u3400-\u9fff]/.test(label) ? label : ''
}
export function catalogDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '时间未记录' : new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date)
}
