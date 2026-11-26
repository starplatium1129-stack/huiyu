import { profileLocalStorage as localStorage } from '@/platform/web/profileStorage'
import { CHAT_LOREBOOKS_KEY } from './storageKeys'

export type LorebookPosition = 'before_char' | 'after_char' | 'at_depth'

export interface LorebookEntry {
  id: string
  comment: string
  keys: string[]
  secondaryKeys: string[]
  content: string
  enabled: boolean
  constant: boolean
  selective: boolean
  useRegex: boolean
  caseSensitive: boolean
  wholeWords: boolean
  position: LorebookPosition
  depth: number
  insertionOrder: number
}

export interface Lorebook {
  id: string
  name: string
  description: string
  enabled: boolean
  scope: 'global' | 'characters'
  characterIds: string[]
  entries: LorebookEntry[]
  updatedAt: number
}

export interface LorebookStore {
  version: 1
  budget: number
  recursive: boolean
  books: Lorebook[]
}

function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

function cleanStringList(value: unknown, maxItems = 40): string[] {
  if (typeof value === 'string') {
    return value.split(',').map(item => item.trim()).filter(Boolean).slice(0, maxItems)
  }
  if (!Array.isArray(value)) return []
  return value
    .map(item => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean)
    .slice(0, maxItems)
}

function normalizePosition(value: unknown): LorebookPosition {
  if (value === 'before_char' || value === 0 || value === '0') return 'before_char'
  if (value === 'at_depth' || value === 4 || value === '4') return 'at_depth'
  return 'after_char'
}

export function createBlankLoreEntry(order = 100): LorebookEntry {
  return {
    id: makeId('lore-entry'),
    comment: '新条目',
    keys: [],
    secondaryKeys: [],
    content: '',
    enabled: true,
    constant: false,
    selective: false,
    useRegex: false,
    caseSensitive: false,
    wholeWords: false,
    position: 'after_char',
    depth: 4,
    insertionOrder: order,
  }
}

export function createBlankLorebook(name = '新建世界书', characterId?: string): Lorebook {
  return {
    id: makeId('lorebook'),
    name: name.trim().slice(0, 64) || '新建世界书',
    description: '',
    enabled: true,
    scope: characterId ? 'characters' : 'global',
    characterIds: characterId ? [characterId] : [],
    entries: [createBlankLoreEntry(100)],
    updatedAt: Date.now(),
  }
}

function normalizeEntry(raw: unknown, fallbackOrder = 100): LorebookEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const enabled = r.enabled === false || r.disable === true ? false : true
  const rawOrder = Number(r.insertionOrder ?? r.insertion_order ?? r.order)
  const rawDepth = Number(r.depth)
  return {
    id: typeof r.id === 'string' && r.id.trim() ? r.id.trim().slice(0, 80) : makeId('lore-entry'),
    comment: String(r.comment ?? r.name ?? '').trim().slice(0, 64),
    keys: cleanStringList(r.keys ?? r.key),
    secondaryKeys: cleanStringList(r.secondaryKeys ?? r.secondary_keys ?? r.keysecondary),
    content: String(r.content ?? '').slice(0, 4000),
    enabled,
    constant: Boolean(r.constant),
    selective: Boolean(r.selective),
    useRegex: Boolean(r.useRegex ?? r.use_regex),
    caseSensitive: Boolean(r.caseSensitive ?? r.case_sensitive),
    wholeWords: Boolean(r.wholeWords ?? r.whole_words ?? r.matchWholeWords),
    position: normalizePosition(r.position),
    depth: Number.isFinite(rawDepth) ? Math.max(0, Math.min(16, Math.round(rawDepth))) : 4,
    insertionOrder: Number.isFinite(rawOrder) ? Math.max(-9999, Math.min(9999, Math.round(rawOrder))) : fallbackOrder,
  }
}

function normalizeBook(raw: unknown): Lorebook | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const rawEntries = Array.isArray(r.entries)
    ? r.entries
    : r.entries && typeof r.entries === 'object'
      ? Object.values(r.entries as Record<string, unknown>)
      : []
  const entries = rawEntries
    .map((entry, idx) => normalizeEntry(entry, (idx + 1) * 10))
    .filter((entry): entry is LorebookEntry => Boolean(entry))
    .slice(0, 200)
  return {
    id: typeof r.id === 'string' && r.id.trim() ? r.id.trim().slice(0, 80) : makeId('lorebook'),
    name: String(r.name ?? '未命名世界书').trim().slice(0, 64) || '未命名世界书',
    description: String(r.description ?? '').trim().slice(0, 200),
    enabled: r.enabled !== false,
    scope: r.scope === 'characters' ? 'characters' : 'global',
    characterIds: Array.isArray(r.characterIds)
      ? r.characterIds.filter((id): id is string => typeof id === 'string' && Boolean(id.trim())).slice(0, 100)
      : [],
    entries,
    updatedAt: Number.isFinite(Number(r.updatedAt)) ? Number(r.updatedAt) : Date.now(),
  }
}

export function loadLorebookStore(): LorebookStore {
  try {
    const raw = JSON.parse(localStorage.getItem(CHAT_LOREBOOKS_KEY) || 'null') as Record<string, unknown> | null
    if (!raw || typeof raw !== 'object') {
      return { version: 1, budget: 4000, recursive: true, books: [] }
    }
    const rawBudget = Number(raw.budget)
    const books = Array.isArray(raw.books)
      ? raw.books.map(normalizeBook).filter((book): book is Lorebook => Boolean(book)).slice(0, 40)
      : []
    return {
      version: 1,
      budget: Number.isFinite(rawBudget) ? Math.max(500, Math.min(16000, Math.round(rawBudget))) : 4000,
      recursive: raw.recursive !== false,
      books,
    }
  } catch {
    return { version: 1, budget: 4000, recursive: true, books: [] }
  }
}

export function saveLorebookStore(store: LorebookStore): LorebookStore {
  const normalized: LorebookStore = {
    version: 1,
    budget: Math.max(500, Math.min(16000, Math.round(Number(store.budget) || 4000))),
    recursive: Boolean(store.recursive),
    books: store.books.slice(0, 40).map(book => ({
      ...book,
      name: book.name.trim().slice(0, 64) || '未命名世界书',
      description: book.description.trim().slice(0, 200),
      entries: book.entries.slice(0, 200),
      updatedAt: Date.now(),
    })),
  }
  localStorage.setItem(CHAT_LOREBOOKS_KEY, JSON.stringify(normalized))
  return normalized
}

export function importTavernLorebookJson(raw: unknown, fallbackName = '导入的世界书'): Lorebook {
  if (!raw || typeof raw !== 'object') {
    throw new Error('世界书 JSON 格式无效')
  }
  const obj = raw as Record<string, unknown>
  const entriesSource = obj.entries
  if (!entriesSource || (typeof entriesSource !== 'object' && !Array.isArray(entriesSource))) {
    throw new Error('未找到 World Info entries 字段')
  }
  const normalized = normalizeBook({
    name: typeof obj.name === 'string' && obj.name.trim() ? obj.name : fallbackName.replace(/\.json$/i, ''),
    description: typeof obj.description === 'string' ? obj.description : '',
    enabled: true,
    scope: 'global',
    characterIds: [],
    entries: entriesSource,
  })
  if (!normalized || !normalized.entries.length) {
    throw new Error('该世界书中没有可识别的条目')
  }
  return normalized
}

export function exportTavernLorebookJson(book: Lorebook): Record<string, unknown> {
  const entries: Record<string, unknown> = {}
  book.entries.forEach((entry, index) => {
    entries[String(index)] = {
      uid: index,
      comment: entry.comment,
      key: entry.keys,
      keysecondary: entry.secondaryKeys,
      content: entry.content,
      disable: !entry.enabled,
      constant: entry.constant,
      selective: entry.selective,
      use_regex: entry.useRegex,
      case_sensitive: entry.caseSensitive,
      whole_words: entry.wholeWords,
      position: entry.position,
      depth: entry.depth,
      order: entry.insertionOrder,
    }
  })
  return {
    name: book.name,
    description: book.description,
    entries,
  }
}

export function collectActiveLorebookPayload(characterId: string): {
  budget: number
  recursive: boolean
  entries: Array<Record<string, unknown>>
} | undefined {
  const store = loadLorebookStore()
  const activeEntries: Array<Record<string, unknown>> = []
  for (const book of store.books) {
    if (!book.enabled) continue
    if (book.scope === 'characters' && !book.characterIds.includes(characterId)) continue
    for (const entry of book.entries) {
      if (!entry.enabled || !entry.content.trim()) continue
      activeEntries.push({
        comment: entry.comment || book.name,
        keys: entry.keys,
        secondary_keys: entry.secondaryKeys,
        enabled: entry.enabled,
        constant: entry.constant,
        selective: entry.selective,
        case_sensitive: entry.caseSensitive,
        use_regex: entry.useRegex,
        whole_words: entry.wholeWords,
        insertion_order: entry.insertionOrder,
        position: entry.position,
        depth: entry.depth,
        content: entry.content,
      })
      if (activeEntries.length >= 200) break
    }
    if (activeEntries.length >= 200) break
  }
  if (!activeEntries.length) return undefined
  return {
    budget: store.budget,
    recursive: store.recursive,
    entries: activeEntries,
  }
}
