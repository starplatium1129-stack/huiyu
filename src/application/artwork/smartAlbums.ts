import { normalizeNewArtworkProject } from './projects.ts'

/** Saved metadata only. All fields combine with AND; tagMatch applies to tags. */
export interface SmartAlbumRule {
  characterId: string
  tags: string[]
  tagMatch: 'all' | 'any'
  favoriteOnly: boolean
  search: string
  projectId: string
}

export interface SmartAlbumDraft {
  id: string
  title: string
  rule: SmartAlbumRule
}

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

export function normalizeSmartAlbumDraft(input: SmartAlbumDraft): SmartAlbumDraft {
  const project = normalizeNewArtworkProject(input)
  return { id: project.id, title: project.title, rule: normalizeSmartAlbumRule(input.rule) }
}
