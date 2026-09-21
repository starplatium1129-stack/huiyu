import { artworkTimestamp, parseArtworkRecords, type ArtworkRecord } from '@/types/artwork'

export function artworkSearchText(item: ArtworkRecord): string {
  return [item.title, item.sceneTitle, item.scene, item.character, item.characterId, item.story, item.project, item.prompt]
    .filter(part => typeof part === 'string' && part).join(' ').toLowerCase()
}
export function matchesArtwork(text: string, query: string): boolean {
  return query.trim().toLowerCase().split(/\s+/).every(part => text.toLowerCase().includes(part))
}
export function indexArtworkSearch(raw: unknown) {
  return parseArtworkRecords(raw).map((item, order) => ({
    id: String(item.id),
    title: String(item.sceneTitle || item.title || item.scene || '未命名作品'),
    path: `/prompt-builder?regen=${encodeURIComponent(String(item.id))}`,
    meta: [artworkTimestamp(item) ? new Date(artworkTimestamp(item)).toLocaleDateString() : '', item.size].filter(Boolean).join(' · '),
    keywords: artworkSearchText(item),
    timestamp: artworkTimestamp(item), order,
  })).sort((a, b) => b.timestamp - a.timestamp || a.order - b.order)
}
