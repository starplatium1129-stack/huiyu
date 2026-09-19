/** Local catalog adapter. No third-party tag data or translations are bundled. */
export interface PromptTagSource {
  en: string
  cn?: string
  cat: string
  aliases?: readonly string[]
  desc?: string
  source?: string
  version?: string
}

export interface PromptTagEntry {
  canonicalTag: string
  zhLabel: string
  aliases: string[]
  category: string
  description: string
  source: string
  version: string
}

const lookupKey = (value: string) => value.trim().toLowerCase().replace(/[\s_]+/g, '_')

export function createPromptTagDictionary(catalog: readonly PromptTagSource[]) {
  const entries = new Map<string, PromptTagEntry>()
  for (const tag of catalog) {
    const canonicalTag = tag.en.trim()
    if (!canonicalTag) continue
    const key = lookupKey(canonicalTag)
    const previous = entries.get(key)
    entries.set(key, {
      canonicalTag: previous?.canonicalTag ?? canonicalTag,
      zhLabel: previous?.zhLabel || tag.cn || '',
      aliases: [...new Set([...(previous?.aliases ?? []), ...(tag.aliases ?? [])])],
      category: previous?.category || tag.cat,
      description: previous?.description || tag.desc || '',
      source: previous?.source || tag.source || 'huiyu/tags',
      version: previous?.version || tag.version || '1',
    })
  }
  const aliases = new Map<string, PromptTagEntry | null>()
  for (const entry of entries.values()) {
    for (const alias of [entry.zhLabel, ...entry.aliases].filter(Boolean)) {
      const key = lookupKey(alias)
      const previous = aliases.get(key)
      // Ambiguous labels stay searchable, but must never silently select a tag.
      aliases.set(key, previous === undefined || previous === entry ? entry : null)
    }
  }
  function lookup(value: string): PromptTagEntry | undefined {
    const key = lookupKey(value)
    return entries.get(key) ?? aliases.get(key) ?? undefined
  }
  function canonicalize(value: string): string {
    const raw = value.trim()
    if (/^<|^BREAK$/i.test(raw)) return raw
    const weighted = raw.match(/^\(([^():]+):\s*([+-]?(?:\d*\.)?\d+)\)$/)
    if (weighted) return `(${lookup(weighted[1])?.canonicalTag ?? weighted[1]}:${weighted[2]})`
    return lookup(raw)?.canonicalTag ?? raw
  }
  return { entries: [...entries.values()], lookup, canonicalize }
}

/** Same search contract for canonical tags, Chinese labels and aliases. */
export function matchesPromptTag(tag: PromptTagSource, query: string, meaning = ''): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const fields = [tag.en, tag.cn || '', ...(tag.aliases ?? []), tag.desc || '', meaning].map(lookupKey)
  return words.every(word => fields.some(field => field.includes(lookupKey(word))))
}
