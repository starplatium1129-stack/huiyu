import { artworkTimestamp, type ArtworkSearchRecord } from '@/types/artwork'

export function indexArtworkSearch(records: readonly ArtworkSearchRecord[]) {
  return records.map(item => ({
    id: String(item.id),
    title: String(item.sceneTitle || item.title || item.scene || '未命名作品'),
    path: `/prompt-builder?regen=${encodeURIComponent(String(item.id))}`,
    size: item.size,
    keywords: item.searchText,
    timestamp: artworkTimestamp(item),
  })).sort((a, b) => b.timestamp - a.timestamp)
}
