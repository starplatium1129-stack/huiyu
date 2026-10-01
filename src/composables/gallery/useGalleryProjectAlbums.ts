import { computed, type Ref } from 'vue'
import { parseSmartAlbumRule, type SmartAlbumRule } from '@/application/artwork/smartAlbums'
import { artworkTimestamp, type ArtworkRecord } from '@/types/artwork'
import type { GalleryProject } from './galleryStorage'
import { characterName as artworkCharacterName, safeImageUrl, searchHaystack } from './galleryHelpers'
import { artworkCharacterIds, matchesSmartAlbum, smartAlbumSummary, UNASSIGNED_CHARACTER_ID } from './galleryAlbumRules'

export interface GalleryProjectAlbum {
  id: string
  title: string
  count: number
  covers: { id: string | number; src: string }[]
  previewIds?: Array<string | number>
  kind: 'manual' | 'smart' | 'character'
  characterId?: string
  ruleSummary?: string
}

interface AlbumMembership extends Omit<GalleryProjectAlbum, 'count' | 'covers'> {
  items: ArtworkRecord[]
}

/** Project covers only borrow the workspace's cache; it owns loading and Blob URL disposal. */
export function useGalleryProjectAlbums(options: {
  projects: Readonly<Ref<readonly GalleryProject[]>>
  history: Readonly<Ref<readonly ArtworkRecord[]>>
  thumbUrls: Readonly<Record<string, string>>
  cardUrls: Readonly<Record<string, string>>
  characterName?: (id: string) => string
}) {
  const records = computed(() => new Map(options.history.value.map(item => [item.id, item])))
  const sortedHistory = computed(() => [...records.value.values()]
    .sort((a, b) => artworkTimestamp(b) - artworkTimestamp(a)))
  const smartRules = computed(() => {
    const rules = new Map<GalleryProject, SmartAlbumRule>()
    for (const project of options.projects.value) {
      if (!Object.hasOwn(project, 'smartRule')) continue
      const rule = parseSmartAlbumRule(project.smartRule)
      if (rule) rules.set(project, rule)
    }
    return rules
  })
  const searching = computed(() => [...smartRules.value.values()].some(rule => Boolean(rule.search)))
  const searchIndex = computed(() => searching.value
    ? new Map(options.history.value.map(item => [item, searchHaystack(item)])) : null)

  // Membership only tracks library metadata; thumbnail arrival cannot rescan prompt bodies.
  const projectMembers = computed<AlbumMembership[]>(() => {
    const projects = options.projects.value
    const index = searchIndex.value
    return projects.flatMap((project): AlbumMembership[] => {
      const rule = smartRules.value.get(project)
      if (Object.hasOwn(project, 'smartRule')) {
        if (!rule) return []
        return [{ id: project.id, title: project.title, kind: 'smart',
          ruleSummary: smartAlbumSummary(rule, options.characterName),
          items: sortedHistory.value.filter(item => matchesSmartAlbum(item, rule, projects, index?.get(item))) }]
      }
      // Match the existing project filter's ID semantics, excluding deleted/stale references.
      const items = [...new Set(project.history_ids)]
        .map(id => records.value.get(id))
        .filter((item): item is ArtworkRecord => Boolean(item))
        .sort((a, b) => artworkTimestamp(b) - artworkTimestamp(a))
      if (!items.length) return []
      return [{ id: project.id, title: project.title, kind: 'manual', items }]
    }).sort((a, b) => (b.items[0] ? artworkTimestamp(b.items[0]) : 0) - (a.items[0] ? artworkTimestamp(a.items[0]) : 0))
  })
  const characterMembers = computed<AlbumMembership[]>(() => {
    const groups = new Map<string, ArtworkRecord[]>()
    for (const item of sortedHistory.value) {
      const identities = artworkCharacterIds(item)
      for (const id of identities.length ? identities : [UNASSIGNED_CHARACTER_ID]) {
        const items = groups.get(id) || []
        items.push(item)
        groups.set(id, items)
      }
    }
    return [...groups].map(([id, items]): AlbumMembership => ({ id: `character:${encodeURIComponent(id)}`,
      title: id === UNASSIGNED_CHARACTER_ID ? '未标注角色'
        : options.characterName?.(id) || artworkCharacterName(id, undefined, []),
      kind: 'character', characterId: id, items }))
  })
  const coverItems = computed(() => {
    const items = new Map<string | number, ArtworkRecord>()
    for (const album of [...projectMembers.value, ...characterMembers.value]) {
      for (const item of album.items.slice(0, 3)) items.set(item.id, item)
    }
    return [...items.values()]
  })
  function decorate(album: AlbumMembership): GalleryProjectAlbum {
    const { items, ...metadata } = album
    const covers: GalleryProjectAlbum['covers'] = []
    for (const item of items) {
      const cached = options.thumbUrls[item.id] || options.cardUrls[item.id] || ''
      const src = /^(blob:|data:image\/)/.test(cached) ? cached : safeImageUrl(cached)
      if (src) covers.push({ id: item.id, src })
      if (covers.length === 3) break
    }
    return { ...metadata, count: items.length, covers, previewIds: items.slice(0, 3).map(item => item.id) }
  }
  const albums = computed(() => projectMembers.value.map(decorate))
  const characterAlbums = computed(() => characterMembers.value.map(decorate))
  return { albums, characterAlbums, coverItems }
}
