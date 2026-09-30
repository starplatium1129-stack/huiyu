import type { ArtworkRecord } from '@/types/artwork'

/** Tags are saved metadata, never inferred by splitting the generation prompt. */
export function artworkTags(item: ArtworkRecord): string[] {
  const values = [...(Array.isArray(item.collectionTags) ? item.collectionTags : []), ...(Array.isArray(item.manual_tags) ? item.manual_tags : []), ...(Array.isArray(item.tags) ? item.tags : [])]
  return [...new Set(values.filter((tag): tag is string => typeof tag === 'string').map(tag => tag.trim()).filter(Boolean))]
}
