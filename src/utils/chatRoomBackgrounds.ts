import { profileLocalStorage as localStorage } from '../platform/web/profileStorage.ts'
import { parseCompanionChatImage, type CompanionChatImage } from '@/types/companionDrawing'
import { CHAT_ROOM_BG_KEY } from './storageKeys.ts'

export interface ChatRoomBackgroundEntry {
  image: CompanionChatImage
  opacity: number
  enabled: boolean
}

export type ChatRoomBackgroundStore = Record<string, ChatRoomBackgroundEntry>

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

export function clampRoomBackgroundOpacity(value: unknown): number {
  const num = Number(value)
  if (!Number.isFinite(num)) return 0.24
  return Math.max(0.12, Math.min(0.45, Math.round(num * 100) / 100))
}

export function loadChatRoomBackgrounds(): ChatRoomBackgroundStore {
  if (typeof globalThis.localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(CHAT_ROOM_BG_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!isRecord(parsed)) return {}
    const out: ChatRoomBackgroundStore = {}
    for (const [charId, entry] of Object.entries(parsed)) {
      if (!charId || charId.length > 100 || !isRecord(entry)) continue
      const image = parseCompanionChatImage(entry.image)
      if (!image) continue
      out[charId] = {
        image,
        opacity: clampRoomBackgroundOpacity(entry.opacity),
        enabled: entry.enabled !== false,
      }
    }
    return out
  } catch {
    return {}
  }
}

export function saveChatRoomBackgrounds(store: ChatRoomBackgroundStore): boolean {
  if (typeof globalThis.localStorage === 'undefined') return false
  try {
    localStorage.setItem(CHAT_ROOM_BG_KEY, JSON.stringify(store))
    return true
  } catch {
    return false
  }
}

export function getChatRoomBackground(characterId: string): ChatRoomBackgroundEntry | null {
  return loadChatRoomBackgrounds()[characterId] || null
}

export function setChatRoomBackground(characterId: string, image: CompanionChatImage, opacity?: number): ChatRoomBackgroundEntry {
  const store = loadChatRoomBackgrounds()
  const entry: ChatRoomBackgroundEntry = {
    image,
    opacity: clampRoomBackgroundOpacity(opacity ?? store[characterId]?.opacity ?? 0.24),
    enabled: true,
  }
  store[characterId] = entry
  saveChatRoomBackgrounds(store)
  return entry
}

export function updateChatRoomBackground(characterId: string, patch: Partial<Pick<ChatRoomBackgroundEntry, 'opacity' | 'enabled'>>): void {
  const store = loadChatRoomBackgrounds()
  const current = store[characterId]
  if (!current) return
  store[characterId] = {
    ...current,
    ...(patch.opacity !== undefined ? { opacity: clampRoomBackgroundOpacity(patch.opacity) } : {}),
    ...(patch.enabled !== undefined ? { enabled: Boolean(patch.enabled) } : {}),
  }
  saveChatRoomBackgrounds(store)
}

export function clearChatRoomBackground(characterId: string): void {
  const store = loadChatRoomBackgrounds()
  if (!store[characterId]) return
  delete store[characterId]
  saveChatRoomBackgrounds(store)
}
