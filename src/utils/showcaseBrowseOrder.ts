import type { ShowcaseEntry, ShowcaseEntryType, ShowcaseRating } from './showcaseManifest'

const typeOrder: Record<ShowcaseEntryType, number> = { scene: 0, popular: 1, artist: 2, lora: 3 }
const ratingOrder: Record<ShowcaseRating, number> = { All: 0, R15: 1, R18: 2 }
const { compare } = new Intl.Collator('zh-CN', { numeric: true })

export function orderShowcaseEntries(entries: readonly ShowcaseEntry[], characterLabel: (id: string) => string) {
  const rows = entries.map(entry => ({
    entry,
    character: entry.type === 'popular' ? characterLabel(entry.char) : '',
  }))
  rows.sort((a, b) => {
    const first = a.entry
    const second = b.entry
    const byType = typeOrder[first.type] - typeOrder[second.type]
    if (byType) return byType

    if (first.type === 'popular') {
      const byCharacter = compare(a.character, b.character) || first.char.localeCompare(second.char)
      const byRating = ratingOrder[first.rating] - ratingOrder[second.rating]
      if (byCharacter || byRating) return byCharacter || byRating
    }
    // Only the scene series has a single shared numbering scheme.
    const byTitle = first.type === 'scene' ? 0 : compare(first.title, second.title)
    return byTitle || compare(first.id, second.id) || first.id.localeCompare(second.id)
  })
  return rows.map(({ entry }) => entry)
}
