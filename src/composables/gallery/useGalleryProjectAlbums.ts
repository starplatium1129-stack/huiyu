import { computed, type Ref } from 'vue'
import { artworkTimestamp, type ArtworkRecord } from '@/types/artwork'
import type { GalleryProject } from './galleryStorage'
import { safeImageUrl } from './galleryHelpers'

export interface GalleryProjectAlbum {
  id: string
  title: string
  count: number
  covers: { id: string | number; src: string }[]
}

/** Project covers only borrow the workspace's cache; it owns loading and Blob URL disposal. */
export function useGalleryProjectAlbums(options: {
  projects: Readonly<Ref<readonly GalleryProject[]>>
  history: Readonly<Ref<readonly ArtworkRecord[]>>
  thumbUrls: Readonly<Record<string, string>>
  cardUrls: Readonly<Record<string, string>>
}) {
  const albums = computed<GalleryProjectAlbum[]>(() => {
    const records = new Map(options.history.value.map(item => [item.id, item]))
    return options.projects.value.flatMap(project => {
      // Match the existing project filter's ID semantics, excluding deleted/stale references.
      const items = [...new Set(project.history_ids)]
        .map(id => records.get(id))
        .filter((item): item is ArtworkRecord => Boolean(item))
        .sort((a, b) => artworkTimestamp(b) - artworkTimestamp(a))
      if (!items.length) return []
      const covers: GalleryProjectAlbum['covers'] = []
      for (const item of items) {
        const cached = options.thumbUrls[item.id] || options.cardUrls[item.id] || ''
        const src = /^(blob:|data:image\/)/.test(cached) ? cached : safeImageUrl(cached)
        if (src) covers.push({ id: item.id, src })
        if (covers.length === 3) break
      }
      return [{ id: project.id, title: project.title, count: items.length, covers }]
    })
  })
  return { albums }
}
