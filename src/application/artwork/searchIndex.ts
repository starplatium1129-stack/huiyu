import { parseArtworkRecords, type ArtworkRecord, type ArtworkSearchRecord } from '../../types/artwork.ts'

export function artworkSearchText(item: ArtworkRecord): string {
  return [item.title, item.sceneTitle, item.scene, item.character, item.characterId, item.story, item.project, item.prompt]
    .filter(part => typeof part === 'string' && part).join(' ').toLowerCase()
}

/** Detached search input; image bytes, recipes and unrelated metadata never cross this read boundary. */
export function buildArtworkSearchIndex(raw: unknown): ArtworkSearchRecord[] {
  return parseArtworkRecords(raw).map(item => structuredClone({
    id: item.id, title: item.title, sceneTitle: item.sceneTitle, scene: item.scene,
    timestamp: item.timestamp, size: item.size, searchText: artworkSearchText(item),
  }))
}

export function parseArtworkSearchIndex(raw: unknown): ArtworkSearchRecord[] {
  if (!Array.isArray(raw) || parseArtworkRecords(raw).length !== raw.length || raw.some(item => typeof item.searchText !== 'string')) {
    throw new Error('作品搜索索引无效')
  }
  return raw.map(({ id, title, sceneTitle, scene, timestamp, size, searchText }) => ({
    id, title, sceneTitle, scene, timestamp, size, searchText,
  }))
}
