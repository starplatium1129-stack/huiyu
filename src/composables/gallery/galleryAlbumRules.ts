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

export function matchesSmartAlbum(
  item: ArtworkRecord,
  rule: SmartAlbumRule,
  projects: readonly GalleryProject[],
  preparedSearchText?: string,
): boolean {
  if (rule.characterId) {
    const identities = artworkCharacterIds(item)
    if (rule.characterId === UNASSIGNED_CHARACTER_ID ? identities.length > 0 : !identities.includes(rule.characterId)) return false
  }
  if (rule.favoriteOnly && !item.favorite) return false
  if (rule.projectId) {
    const project = projects.find(candidate => candidate.id === rule.projectId && !Object.hasOwn(candidate, 'smartRule'))
    if (!project || !project.history_ids.includes(item.id)) return false
  }
  if (rule.tags.length) {
    const tags = artworkTags(item)
    const matchesTag = (tag: string) => tags.includes(tag)
    if (rule.tagMatch === 'any' ? !rule.tags.some(matchesTag) : !rule.tags.every(matchesTag)) return false
  }
  const terms = rule.search.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return true
  const haystack = preparedSearchText ?? searchHaystack(item)
  return terms.every(term => haystack.includes(term))
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
