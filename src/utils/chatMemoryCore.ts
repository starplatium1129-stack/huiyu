import { assertChatVersion } from './chatVersion.ts'
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
  /** Explicit user topic. Only its latest fact is recalled; older facts remain editable. */
  topic?: string
}

export interface ChatMemoryState {
  version: 1
  byCharacter: Record<string, ChatMemoryItem[]>
}

const MAX_ITEMS = 200
const MAX_TEXT = 240

export function emptyChatMemoryState(): ChatMemoryState {
  const state: ChatMemoryState = {
    version: 1,
    byCharacter: Object.fromEntries(listCompanionCharacterIds().map(id => [id, []])),
  }
  return state
}

function cleanText(value: unknown): string {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT)
}
export { cleanText as normalizeChatMemoryText }

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
    ...(typeof record.topic === 'string' && record.topic.trim() ? { topic: cleanText(record.topic).slice(0, 40) } : {}),
  }
}

export function normalizeChatMemoryState(value: unknown): ChatMemoryState {
  assertChatVersion(value, 1)
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
      const key = `${item.topic || ''}\n${item.text}`.toLocaleLowerCase()
      if (seen.has(key) || seenIds.has(item.id)) continue
      seen.add(key)
      seenIds.add(item.id)
      state.byCharacter[character].push(item)
      if (state.byCharacter[character].length >= MAX_ITEMS) break
    }
  }
  return state
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
      const key = `${item.topic || ''}\n${item.text}`.toLocaleLowerCase()
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
  if (list.length >= MAX_ITEMS) throw new Error('长期记忆已满 200 条，请先整理已有记忆；本次未覆盖旧内容。')
  const now = Date.now()
  const item: ChatMemoryItem = {
    id: memoryId(), character, text, sourceMid: cleanText(sourceMid), createdAt: now, updatedAt: now, pinned: true,
  }
  list.unshift(item)
  return item
}

export function editChatFact(state: ChatMemoryState, character: ChatMemoryCharacter, id: string, textValue: string, topic = ''): boolean {
  const item = state.byCharacter[character]?.find(memory => memory.id === id)
  const text = cleanText(textValue)
  if (!item || !text) return false
  item.text = text
  item.topic = cleanText(topic).slice(0, 40) || undefined
  item.updatedAt = Date.now()
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

export { recallChatFacts } from './chatMemoryRecall'
