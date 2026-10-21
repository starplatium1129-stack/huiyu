import type { GalleryCatalog } from '@/application/artwork/galleryQuery'
import { computed, type Ref } from 'vue'
import { parseSmartAlbumRule, type SmartAlbumRule } from '@/application/artwork/smartAlbums'
import { artworkTimestamp, type ArtworkRecord } from '@/types/artwork'
import type { GalleryProject } from './galleryStorage'
import { artworkIdKey, characterName as artworkCharacterName, safeImageUrl, searchHaystack } from './galleryHelpers'
import { artworkCharacterIds, createSmartAlbumMatcher, smartAlbumSummary, UNASSIGNED_CHARACTER_ID } from './galleryAlbumRules'

export interface GalleryProjectAlbum {
  id: string
  title: string
  count: number
  countPending: boolean
  covers: { id: string | number; src: string }[]
  kind: 'manual' | 'smart' | 'character'
  characterId?: string
  ruleSummary?: string
}

interface AlbumMembership extends Omit<GalleryProjectAlbum, 'count' | 'countPending' | 'covers'> {
  count?: number
  items: ArtworkRecord[]
}

/** Project covers only borrow the workspace's cache; it owns loading and Blob URL disposal. */
export function useGalleryProjectAlbums(options: {
  projects: Readonly<Ref<readonly GalleryProject[]>>
  history: Readonly<Ref<readonly ArtworkRecord[]>>
  indexComplete: Readonly<Ref<boolean>>
  thumbUrls: Readonly<Ref<Readonly<Record<string, string>>>>
  cardUrls: Readonly<Ref<Readonly<Record<string, string>>>>
  catalog?: Readonly<Ref<GalleryCatalog | null>>
  characterName?: (id: string) => string
}) {
  const records = computed(() => new Map(options.history.value.map(item => [artworkIdKey(item.id), item])))
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

  function catalogItems(ids: Array<string | number>) {
    const records = new Map(options.catalog?.value?.covers.map(item => [artworkIdKey(item.id), item]));
    return ids.flatMap(id => { const record = records.get(artworkIdKey(id)); return record ? [record] : [] })
  }
  // Membership only tracks library metadata; thumbnail arrival cannot rescan prompt bodies.
  const projectMembers = computed<AlbumMembership[]>(() => {
    const projects = options.projects.value
    if (options.catalog?.value) return options.catalog.value.albums.flatMap(album => {
      const project = projects.find(project => project.id === album.id)
      if (!project || !album.count && !project.smartRule) return []
      return [{ id: project.id, title: project.title, kind: project.smartRule ? 'smart' as const : 'manual' as const, count: album.count,
        ...(project.smartRule ? { ruleSummary: smartAlbumSummary(project.smartRule, options.characterName) } : {}), items: catalogItems(album.coverIds) }]
    }).sort((a, b) => (b.items[0] ? artworkTimestamp(b.items[0]) : 0) - (a.items[0] ? artworkTimestamp(a.items[0]) : 0))
    const index = searchIndex.value
    return projects.flatMap((project): AlbumMembership[] => {
      const rule = smartRules.value.get(project)
      if (Object.hasOwn(project, 'smartRule')) {
        if (!rule) return []
        const matches = createSmartAlbumMatcher(rule, projects)
        return [{ id: project.id, title: project.title, kind: 'smart',
          ruleSummary: smartAlbumSummary(rule, options.characterName),
          items: sortedHistory.value.filter(item => matches(item, index?.get(item))) }]
      }
      // Missing members are only stale once the complete library has arrived.
      const items = [...new Set(project.history_ids.map(artworkIdKey))]
        .map(id => records.value.get(id))
        .filter((item): item is ArtworkRecord => Boolean(item))
        .sort((a, b) => artworkTimestamp(b) - artworkTimestamp(a))
      if (!items.length && (options.indexComplete.value || !project.history_ids.length)) return []
      return [{ id: project.id, title: project.title, kind: 'manual', items }]
    }).sort((a, b) => (b.items[0] ? artworkTimestamp(b.items[0]) : 0) - (a.items[0] ? artworkTimestamp(a.items[0]) : 0))
  })
  const characterMembers = computed<AlbumMembership[]>(() => {
    if (options.catalog?.value) return options.catalog.value.characters.map<AlbumMembership>(album => ({ id: `character:${encodeURIComponent(album.id)}`,
      title: album.id === UNASSIGNED_CHARACTER_ID ? '未标注角色' : options.characterName?.(album.id) || artworkCharacterName(album.id, undefined, []),
      kind: 'character', characterId: album.id, count: album.count, items: catalogItems(album.coverIds) })).sort((a, b) => (b.items[0] ? artworkTimestamp(b.items[0]) : 0) - (a.items[0] ? artworkTimestamp(a.items[0]) : 0))
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
  // Thumbnail demand depends on membership, never on arrivals in the borrowed cache.
  function resolvePreviewItems(section: 'characters' | 'albums', visibleIds: readonly string[]) {
    const visible = new Set(visibleIds)
    const ids = new Set((section === 'characters' ? characterMembers.value : projectMembers.value)
      .filter(album => visible.has(album.id)).flatMap(album => album.items.slice(0, 3).map(item => item.id)))
    return (options.catalog?.value?.covers || options.history.value).filter(item => ids.has(item.id))
  }
  function decorate(album: AlbumMembership): GalleryProjectAlbum {
    const { items, ...metadata } = album
    // Counts and character options do not need covers. Defer cache reads (and
    // their reactive subscriptions) until an album actually renders its covers.
    const covers = computed(() => {
      const result: GalleryProjectAlbum['covers'] = []
      for (const item of items) {
        const cached = options.thumbUrls.value[item.id] || options.cardUrls.value[item.id] || ''
        const src = /^(blob:|data:image\/)/.test(cached) ? cached : safeImageUrl(cached)
        if (src) result.push({ id: item.id, src })
        if (result.length === 3) break
      }
      return result
    })
    return { ...metadata, count: album.count ?? items.length, countPending: !options.indexComplete.value, get covers() { return covers.value } }
  }
  const albums = computed(() => projectMembers.value.map(decorate))
  const characterAlbums = computed(() => characterMembers.value.map(decorate))
  return { albums, characterAlbums, resolvePreviewItems }
}
