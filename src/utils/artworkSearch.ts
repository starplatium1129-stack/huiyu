import { artworkTimestamp, type ArtworkSearchSummary } from '@/types/artwork'

export function indexArtworkSearch(records: readonly ArtworkSearchSummary[]) {
  return records.map(item => ({
    id: String(item.id),
    title: String(item.sceneTitle || item.title || item.scene || '未命名作品'),
    path: `/prompt-builder?regen=${encodeURIComponent(String(item.id))}`,
    size: item.size,
    timestamp: artworkTimestamp(item),
  })).sort((a, b) => b.timestamp - a.timestamp)
}
