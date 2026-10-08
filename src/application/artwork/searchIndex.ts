import { artworkTimestamp, parseArtworkRecords, type ArtworkRecord, type ArtworkSearchSummary } from '../../types/artwork.ts'

export function artworkSearchText(item: ArtworkRecord): string {
  return [item.title, item.sceneTitle, item.scene, item.character, item.characterId, item.story, item.project, item.prompt]
    .filter(part => typeof part === 'string' && part).join(' ').toLowerCase()
}

export function artworkSearchTerms(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean)
}

/** Local Web/offline search retains five detached summaries, never a full text copy. */
export function searchArtworkRecords(raw: unknown, query: string): ArtworkSearchSummary[] {
  const terms = artworkSearchTerms(query)
  if (!terms.length) return []
  const selected: ArtworkRecord[] = []
  for (const item of parseArtworkRecords(raw)) {
    const text = artworkSearchText(item)
    if (!terms.every(term => text.includes(term))) continue
    selected.push(item)
    selected.sort((a, b) => artworkTimestamp(b) - artworkTimestamp(a))
    selected.length = Math.min(selected.length, 5)
  }
  return structuredClone(parseArtworkSearchSummaries(selected))
}

export function parseArtworkSearchSummaries(raw: unknown): ArtworkSearchSummary[] {
  if (!Array.isArray(raw) || raw.length > 205 || parseArtworkRecords(raw).length !== raw.length) {
    throw new Error('作品搜索响应无效')
  }
  return raw.map(({ id, title, sceneTitle, scene, timestamp, size }) => ({ id, title, sceneTitle, scene, timestamp, size }))
}
