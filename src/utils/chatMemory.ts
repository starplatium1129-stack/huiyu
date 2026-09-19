import { CHAT_MEMORY_KEY } from './storageKeys.ts'
import {
  DEFAULT_COMPANION_CHARACTER_ID,
  isCompanionCharacterId,
  listCompanionCharacterIds,
} from './companionRegistry.ts'

export type ChatMemoryCharacter = string

export interface ChatMemoryItem {
  id: string
  character: ChatMemoryCharacter
  text: string
  sourceMid: string
  createdAt: number
  updatedAt: number
  pinned: boolean
}

export interface ChatMemoryState {
  version: 1
  byCharacter: Record<string, ChatMemoryItem[]>
}

const MAX_ITEMS = 200
const MAX_TEXT = 240

export function emptyChatMemoryState(): ChatMemoryState {
  return {
    version: 1,
    byCharacter: Object.fromEntries(listCompanionCharacterIds().map(id => [id, []])),
  }
}

function cleanText(value: unknown): string {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT)
}

function memoryId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `memory-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function normalizeCharacter(value: unknown, fallback = DEFAULT_COMPANION_CHARACTER_ID): ChatMemoryCharacter | null {
  if (isCompanionCharacterId(value)) return value
  return isCompanionCharacterId(fallback) ? fallback : null
}

function normalizeItem(value: unknown, fallbackCharacter: ChatMemoryCharacter): ChatMemoryItem | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record.character != null && !isCompanionCharacterId(record.character)) return null
  const character = normalizeCharacter(record.character, fallbackCharacter)
  if (!character) return null
  const text = cleanText(record.text)
  if (!text) return null
  const createdAt = Number(record.createdAt)
  const updatedAt = Number(record.updatedAt)
  return {
    id: cleanText(record.id) || memoryId(),
    character,
    text,
    sourceMid: cleanText(record.sourceMid),
    createdAt: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : Date.now(),
    updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : Date.now(),
    pinned: record.pinned !== false,
  }
}

export function normalizeChatMemoryState(value: unknown): ChatMemoryState {
  const state = emptyChatMemoryState()
  if (!value || typeof value !== 'object' || Array.isArray(value)) return state
  const byCharacter = (value as Record<string, unknown>).byCharacter
  if (!byCharacter || typeof byCharacter !== 'object' || Array.isArray(byCharacter)) return state
  for (const character of listCompanionCharacterIds()) {
    const source = (byCharacter as Record<string, unknown>)[character]
    if (!Array.isArray(source)) continue
    const seen = new Set<string>()
    const seenIds = new Set<string>()
    const items = source.map(raw => normalizeItem(raw, character)).filter((item): item is ChatMemoryItem => Boolean(item && item.character === character)).sort((a, b) => b.updatedAt - a.updatedAt)
    for (const item of items) {
      const key = item.text.toLocaleLowerCase()
      if (seen.has(key) || seenIds.has(item.id)) continue
      seen.add(key)
      seenIds.add(item.id)
      state.byCharacter[character].push(item)
      if (state.byCharacter[character].length >= MAX_ITEMS) break
    }
  }
  return state
}

export function loadChatMemoryState(): ChatMemoryState {
  try {
    return normalizeChatMemoryState(JSON.parse(localStorage.getItem(CHAT_MEMORY_KEY) || 'null'))
  } catch {
    return emptyChatMemoryState()
  }
}

export function saveChatMemoryState(state: ChatMemoryState): void {
  localStorage.setItem(CHAT_MEMORY_KEY, JSON.stringify(normalizeChatMemoryState(state)))
}

/** Re-read persisted state before editing; a failed write never changes the displayed snapshot. */
export function changeStoredChatMemory(change: (state: ChatMemoryState) => boolean): ChatMemoryState | null {
  const state = normalizeChatMemoryState(JSON.parse(localStorage.getItem(CHAT_MEMORY_KEY) || 'null'))
  if (!change(state)) return null
  const normalized = normalizeChatMemoryState(state)
  saveChatMemoryState(normalized)
  return normalized
}

export function mergeChatMemoryStates(current: ChatMemoryState, incoming: ChatMemoryState): ChatMemoryState {
  current = normalizeChatMemoryState(current)
  incoming = normalizeChatMemoryState(incoming)
  const merged = emptyChatMemoryState()
  for (const character of listCompanionCharacterIds()) {
    const seen = new Set<string>()
    const seenIds = new Set<string>()
    const items = [...current.byCharacter[character], ...incoming.byCharacter[character]]
      .sort((a, b) => b.updatedAt - a.updatedAt)
    for (const item of items) {
      const key = item.text.toLocaleLowerCase()
      if (seen.has(key) || seenIds.has(item.id)) continue
      seen.add(key)
      seenIds.add(item.id)
      merged.byCharacter[character].push(item)
      if (merged.byCharacter[character].length >= MAX_ITEMS) break
    }
  }
  return merged
}

export function rememberChatFact(
  state: ChatMemoryState,
  character: ChatMemoryCharacter,
  textValue: string,
  sourceMid = '',
): ChatMemoryItem | null {
  const text = cleanText(textValue)
  if (!text) return null
  const list = state.byCharacter[character] ||= []
  const existing = list.find(item => (sourceMid && item.sourceMid === sourceMid) || item.text.toLocaleLowerCase() === text.toLocaleLowerCase())
  if (existing) {
    existing.text = text
    existing.sourceMid = cleanText(sourceMid) || existing.sourceMid
    existing.updatedAt = Date.now()
    existing.pinned = true
    return existing
  }
  const now = Date.now()
  const item: ChatMemoryItem = {
    id: memoryId(), character, text, sourceMid: cleanText(sourceMid), createdAt: now, updatedAt: now, pinned: true,
  }
  list.unshift(item)
  if (list.length > MAX_ITEMS) list.splice(MAX_ITEMS)
  return item
}

export function editChatFact(state: ChatMemoryState, character: ChatMemoryCharacter, id: string, textValue: string): boolean {
  const item = state.byCharacter[character]?.find(memory => memory.id === id)
  const text = cleanText(textValue)
  if (!item || !text) return false
  item.text = text
  item.updatedAt = Date.now()
  state.byCharacter[character] = state.byCharacter[character].filter(memory => memory === item || memory.text.toLocaleLowerCase() !== text.toLocaleLowerCase())
  return true
}

export function removeChatFact(state: ChatMemoryState, character: ChatMemoryCharacter, id: string): boolean {
  const list = state.byCharacter[character]
  if (!list) return false
  const index = list.findIndex(item => item.id === id)
  if (index < 0) return false
  list.splice(index, 1)
  return true
}

export function isChatFactRemembered(state: ChatMemoryState, character: ChatMemoryCharacter, sourceMid: string): boolean {
  return Boolean(sourceMid && state.byCharacter[character]?.some(item => item.sourceMid === sourceMid))
}

function relevanceTerms(value: string): Set<string> {
  const text = cleanText(value).toLocaleLowerCase()
  const terms = new Set<string>(text.match(/[a-z0-9][a-z0-9_-]+/g) || [])
  for (const sequence of text.match(/[\u3400-\u9fff]+/g) || []) {
    if (sequence.length === 1) terms.add(sequence)
    for (let index = 0; index < sequence.length - 1; index += 1) terms.add(sequence.slice(index, index + 2))
  }
  return terms
}

export function recallChatFacts(
  state: ChatMemoryState,
  character: ChatMemoryCharacter,
  query: string,
  limit = 4,
  budget = 1000,
): string[] {
  if (!state.byCharacter[character]) return []
  const queryTerms = relevanceTerms(query)
  const ranked = state.byCharacter[character].map(item => {
    const terms = relevanceTerms(item.text)
    let overlap = 0
    for (const term of queryTerms) if (terms.has(term)) overlap += 1
    const relevance = queryTerms.size ? overlap / queryTerms.size : 0
    return { item, overlap, score: (item.pinned ? 2 : 0) + relevance * 10 + item.updatedAt / 1e15 }
  }).filter(candidate => candidate.overlap > 0)
    .sort((left, right) => right.score - left.score)

  const out: string[] = []
  let used = 0
  for (const { item } of ranked) {
    if (out.length >= Math.max(0, limit)) break
    if (used + item.text.length > budget) continue
    out.push(item.text)
    used += item.text.length
  }
  return out
}
