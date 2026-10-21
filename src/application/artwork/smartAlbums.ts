import { ARTWORK_PROJECT_TITLE_LIMIT, normalizeNewArtworkProject } from './projects.ts'

/** Saved metadata only. All fields combine with AND; tagMatch applies to tags. */
export interface SmartAlbumRule {
  characterId: string
  tags: string[]
  tagMatch: 'all' | 'any'
  favoriteOnly: boolean
  search: string
  projectId: string
}

export interface SmartAlbumFields {
  title: string
  rule: SmartAlbumRule
}

export type SmartAlbumDraft = SmartAlbumFields & { id: string } & (
  | { mode: 'create'; baseline?: never }
  | { mode: 'edit'; baseline: SmartAlbumFields }
)

export interface SmartAlbumRemoval { id: string; baseline: SmartAlbumFields }

export class SmartAlbumConflictError extends Error {}

function text(value: unknown, limit: number): string {
  if (typeof value !== 'string' || value.trim().length > limit) throw new Error('智能画册条件无效')
  return value.trim()
}

export function normalizeSmartAlbumRule(input: unknown): SmartAlbumRule {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('智能画册条件无效')
  const rule = input as Record<string, unknown>
  if (!Array.isArray(rule.tags) || rule.tags.length > 64
    || (rule.tagMatch !== 'all' && rule.tagMatch !== 'any') || typeof rule.favoriteOnly !== 'boolean') {
    throw new Error('智能画册条件无效')
  }
  const tags = rule.tags.map(value => {
    const tag = text(value, 64)
    if (!tag) throw new Error('智能画册标签不能为空')
    return tag
  })
  return { characterId: text(rule.characterId, 200), tags: [...new Set(tags)],
    tagMatch: rule.tagMatch, favoriteOnly: rule.favoriteOnly, search: text(rule.search, 500), projectId: text(rule.projectId, 200) }
}

/** Malformed saved rules never broaden an album into an unrestricted query. */
export function parseSmartAlbumRule(input: unknown): SmartAlbumRule | null {
  try { return normalizeSmartAlbumRule(input) } catch { return null }
}

function normalizeBaseline(input: unknown): SmartAlbumFields {
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof (input as SmartAlbumFields).title !== 'string') {
    throw new Error('智能画册缺少有效的原始内容，请重新打开')
  }
  const baseline = input as SmartAlbumFields
  return { title: baseline.title, rule: normalizeSmartAlbumRule(baseline.rule) }
}

export function normalizeSmartAlbumDraft(input: SmartAlbumDraft): SmartAlbumDraft {
  if (!input || typeof input !== 'object' || Array.isArray(input) || (input.mode !== 'create' && input.mode !== 'edit')) {
    throw new Error('智能画册保存方式无效')
  }
  // Existing portable/legacy IDs need not follow the new-project ID format.
  const project = input.mode === 'create' ? normalizeNewArtworkProject(input)
    : { id: typeof input.id === 'string' ? input.id.trim() : '', title: text(input.title, ARTWORK_PROJECT_TITLE_LIMIT) }
  if (!project.id) throw new Error('画册编号无效')
  if (!project.title) throw new Error('请填写画册名称')
  const fields = { id: project.id, title: project.title, rule: normalizeSmartAlbumRule(input.rule) }
  if (input.mode === 'create') {
    if (Object.hasOwn(input, 'baseline')) throw new Error('新建智能画册不能携带编辑基线')
    return { ...fields, mode: 'create' }
  }
  return { ...fields, mode: 'edit', baseline: normalizeBaseline(input.baseline) }
}

export function normalizeSmartAlbumRemoval(input: SmartAlbumRemoval): SmartAlbumRemoval {
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.id !== 'string' || !input.id.trim()) {
    throw new Error('画册编号无效')
  }
  return { id: input.id.trim(), baseline: normalizeBaseline(input.baseline) }
}

/** Editable-field equality only, not a record-generation / ABA identity check. */
function matchesFields(current: Record<string, unknown>, fields: SmartAlbumFields) {
  return String(current.title || current.name || current.id) === fields.title
    && JSON.stringify(parseSmartAlbumRule(current.smartRule)) === JSON.stringify(fields.rule)
}

/** Returning false observes the desired state; it does not confirm an earlier operation. */
export function shouldWriteSmartAlbum(current: Record<string, unknown> | null | undefined, draft: SmartAlbumDraft): boolean {
  if (!current) {
    if (draft.mode === 'edit') throw new SmartAlbumConflictError('智能画册已被移除，当前输入已保留；请核对后另行新建')
    return true
  }
  if (!Object.hasOwn(current, 'smartRule')) throw new SmartAlbumConflictError('画册编号已被手动画册使用，当前输入已保留')
  if (matchesFields(current, draft)) return false
  if (draft.mode === 'create') throw new SmartAlbumConflictError('画册编号已存在且内容不同，当前输入已保留；请核对后重新新建')
  if (!matchesFields(current, draft.baseline)) throw new SmartAlbumConflictError('智能画册已在其他位置修改，当前输入已保留；请核对最新内容后重新打开')
  return true
}

/** An absent record is current state, not proof that an earlier deletion committed. */
export function shouldDeleteSmartAlbum(current: Record<string, unknown> | null | undefined, removal: SmartAlbumRemoval): boolean {
  if (!current) return false
  if (!Object.hasOwn(current, 'smartRule') || !matchesFields(current, removal.baseline)) {
    throw new SmartAlbumConflictError('画册内容已变化，请重新核对后移除')
  }
  return true
}
