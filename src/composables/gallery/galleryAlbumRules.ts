import type { SmartAlbumRule } from '@/application/artwork/smartAlbums'
import type { ArtworkRecord } from '@/types/artwork'
import type { GalleryProject } from './galleryStorage'
import { artworkTags } from './artworkTags'
import { characterName as artworkCharacterName, searchHaystack } from './galleryHelpers'

export const UNASSIGNED_CHARACTER_ID = '__unassigned__'

function expandCharacterIdentity(id: string): string[] {
  return id === 'triad' || id === 'both' ? ['nene', 'natsume'] : [id]
}

/** Character identities come only from explicit saved metadata, never prompts or pixels. */
export function artworkCharacterIds(item: ArtworkRecord): string[] {
  const primary = typeof item.characterId === 'string' && item.characterId.trim()
    ? item.characterId.trim() : typeof item.character === 'string' ? item.character.trim() : ''
  const additional = Array.isArray(item.characterIds) ? item.characterIds : []
  const identities = [primary, ...additional]
    .filter((value): value is string => typeof value === 'string')
    .map(value => value.trim()).filter(Boolean)
  return [...new Set(identities.flatMap(expandCharacterIdentity))]
}

/** Prepare rule-wide work once per reactive snapshot, not once per artwork. */
export function createSmartAlbumMatcher(rule: SmartAlbumRule, projects: readonly GalleryProject[]) {
  const { characterId, favoriteOnly, projectId, tagMatch } = rule
  const tags = [...rule.tags]
  const project = projectId ? projects.find(candidate => candidate.id === projectId && !Object.hasOwn(candidate, 'smartRule')) : null
  const projectIds = projectId ? new Set(project?.history_ids || []) : null
  const terms = rule.search.trim().toLowerCase().split(/\s+/).filter(Boolean)
  return (item: ArtworkRecord, preparedSearchText?: string): boolean => {
    if (characterId) {
      const identities = artworkCharacterIds(item)
      if (characterId === UNASSIGNED_CHARACTER_ID ? identities.length > 0 : !identities.includes(characterId)) return false
    }
    if (favoriteOnly && !item.favorite) return false
    if (projectIds && !projectIds.has(item.id)) return false
    if (tags.length) {
      const itemTags = artworkTags(item)
      const matchesTag = (tag: string) => itemTags.includes(tag)
      if (tagMatch === 'any' ? !tags.some(matchesTag) : !tags.every(matchesTag)) return false
    }
    if (!terms.length) return true
    const haystack = preparedSearchText ?? searchHaystack(item)
    return terms.every(term => haystack.includes(term))
  }
}

export function smartAlbumSummary(rule: SmartAlbumRule, characterName?: (id: string) => string): string {
  const parts: string[] = []
  if (rule.characterId) {
    const title = rule.characterId === UNASSIGNED_CHARACTER_ID ? '未标注角色'
      : characterName?.(rule.characterId) || artworkCharacterName(rule.characterId, undefined, [])
    parts.push(`角色：${title}`)
  }
  if (rule.tags.length) parts.push(`${rule.tagMatch === 'any' ? '任一标签' : '全部标签'}：${rule.tags.join('、')}`)
  if (rule.favoriteOnly) parts.push('仅收藏')
  if (rule.search) parts.push(`搜索：${rule.search}`)
  if (rule.projectId) parts.push('指定画册内')
  return parts.join(' · ') || '全部作品，自动更新'
}
