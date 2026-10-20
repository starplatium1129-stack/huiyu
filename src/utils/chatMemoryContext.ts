// Match chat/persona.rs: at most four entries, 240 UTF-16 units each, 1000 total.
const MAX_ITEMS = 4
const MAX_ITEM_LENGTH = 240
const MAX_TOTAL_LENGTH = 1000

function contextEntry(value: string): string {
  // Older stored text may end in a lone surrogate after its UTF-16 slice.
  const clean = value.replace(/[\ud800-\udfff]/gu, '')
    .replace(/[\u0000-\u001f\u007f-\u009f\ufeff\s]+/gu, ' ').trim()
  let text = ''
  for (const character of clean) {
    if (text.length + character.length > MAX_ITEM_LENGTH) break
    text += character
  }
  return text.trimEnd()
}

/** Keep the leading setting first without letting setting cards crowd out facts.
 * Both inputs retain their existing relevance order; spare slots return to settings.
 * Only this transport projection is shortened, never saved memories or setting cards.
 */
export function packChatMemoryContext(settings: readonly string[], facts: readonly string[]): string[] {
  const settingEntries = settings.map(contextEntry).filter(Boolean)
  const candidates = [...settingEntries.slice(0, 1), ...facts.map(contextEntry), ...settingEntries.slice(1)]
  const packed: string[] = []
  let used = 0
  for (const entry of candidates) {
    if (!entry || packed.includes(entry) || used + entry.length > MAX_TOTAL_LENGTH) continue
    packed.push(entry)
    used += entry.length
    if (packed.length === MAX_ITEMS) break
  }
  return packed
}
