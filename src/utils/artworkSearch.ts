import { artworkTimestamp, parseArtworkRecords, type ArtworkRecord } from '@/types/artwork'

export function artworkSearchText(item: ArtworkRecord): string {
  return [item.title, item.sceneTitle, item.scene, item.character, item.characterId, item.story, item.project, item.prompt]
    .filter(part => typeof part === 'string' && part).join(' ').toLowerCase()
}
export function indexArtworkSearch(raw: unknown) {
  return parseArtworkRecords(raw).map(item => ({
    id: String(item.id),
    title: String(item.sceneTitle || item.title || item.scene || '未命名作品'),
    path: `/prompt-builder?regen=${encodeURIComponent(String(item.id))}`,
    size: item.size,
    keywords: artworkSearchText(item),
    timestamp: artworkTimestamp(item),
  })).sort((a, b) => b.timestamp - a.timestamp)
}
