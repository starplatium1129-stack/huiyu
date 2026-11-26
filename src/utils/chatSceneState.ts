import { profileLocalStorage as localStorage } from '../platform/web/profileStorage.ts'
import { CHAT_SCENE_STATE_KEY } from './storageKeys.ts'

export interface ChatSceneState {
  location: string
  outfit: string
  mood: string
  updatedAt: number
}

export type ChatSceneStateStore = Record<string, ChatSceneState>

export interface ExtractedStatusUpdate {
  affectionDelta?: number
  mood?: 'neutral' | 'happy' | 'gentle' | 'shy' | 'serious' | 'sad'
  location?: string
  outfit?: string
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const clean = (value: unknown, maxLength: number): string =>
  typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength)
    : ''

export function normalizeChatSceneState(raw: unknown): ChatSceneState {
  if (!isRecord(raw)) return { location: '', outfit: '', mood: '', updatedAt: 0 }
  return {
    location: clean(raw.location, 80),
    outfit: clean(raw.outfit, 160),
    mood: clean(raw.mood, 40),
    updatedAt: Number.isFinite(Number(raw.updatedAt)) ? Number(raw.updatedAt) : 0,
  }
}

export function loadChatSceneStates(): ChatSceneStateStore {
  if (typeof globalThis.localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(CHAT_SCENE_STATE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!isRecord(parsed)) return {}
    const out: ChatSceneStateStore = {}
    for (const [charId, entry] of Object.entries(parsed)) {
      if (!charId || charId.length > 100) continue
      const normalized = normalizeChatSceneState(entry)
      if (normalized.location || normalized.outfit || normalized.mood) {
        out[charId] = normalized
      }
    }
    return out
  } catch {
    return {}
  }
}

export function saveChatSceneStates(store: ChatSceneStateStore): boolean {
  if (typeof globalThis.localStorage === 'undefined') return false
  try {
    localStorage.setItem(CHAT_SCENE_STATE_KEY, JSON.stringify(store))
    return true
  } catch {
    return false
  }
}

function mapMoodLabel(raw: string): ExtractedStatusUpdate['mood'] {
  const value = raw.trim().toLowerCase()
  if (!value) return undefined
  if (/害羞|羞|脸红|羞赧|shy|blush/.test(value)) return 'shy'
  if (/开心|高兴|快乐|兴奋|愉悦|笑|happy|joy/.test(value)) return 'happy'
  if (/温柔|安心|柔和|体贴|暖|gentle|warm/.test(value)) return 'gentle'
  if (/认真|严肃|专注|警惕|紧张|serious|focus/.test(value)) return 'serious'
  if (/难过|伤心|低落|委屈|哭|失落|sad|upset/.test(value)) return 'sad'
  if (/平静|普通|日常|淡定|放松|neutral|calm/.test(value)) return 'neutral'
  return undefined
}

function parseAffectionDelta(raw: string, currentScore?: number): number | undefined {
  const deltaMatch = raw.match(/([+-]\s*\d+)/)
  if (deltaMatch) {
    const num = Number(deltaMatch[1].replace(/\s+/g, ''))
    if (Number.isFinite(num)) return Math.max(-5, Math.min(5, Math.round(num)))
  }
  const absMatch = raw.match(/^\s*(\d{1,3})\s*(?:\/\s*100)?\s*$/)
  if (absMatch && currentScore !== undefined) {
    const target = Number(absMatch[1])
    if (Number.isFinite(target) && target >= 0 && target <= 100) {
      return Math.max(-5, Math.min(5, Math.round(target - currentScore)))
    }
  }
  return undefined
}

export function extractStatusUpdate(replyText: string, currentScore?: number): ExtractedStatusUpdate | null {
  if (!replyText) return null
  const matches = [...replyText.matchAll(/<status\b[^>]*>([\s\S]*?)(?:<\/status>|$)/gi)]
  const lastBody = matches.at(-1)?.[1]?.trim()
  if (!lastBody) return null

  const update: ExtractedStatusUpdate = {}
  for (const rawLine of lastBody.split(/\r?\n/)) {
    const cleanLine = rawLine.trim().replace(/^[-*•]\s*/, '')
    const match = cleanLine.match(/^([^:：\n]{1,30})[：:]\s*(.+)$/)
    if (!match) continue
    const key = match[1].trim().toLowerCase()
    const val = match[2].trim()
    if (!val) continue
    if (/^(?:好感|好感度|亲密度|羁绊|affection|intimacy)$/.test(key)) {
      const delta = parseAffectionDelta(val, currentScore)
      if (delta !== undefined) update.affectionDelta = delta
    } else if (/^(?:心情|情绪|状态|mood|emotion)$/.test(key)) {
      const mood = mapMoodLabel(val)
      if (mood) update.mood = mood
    } else if (/^(?:地点|场景|位置|location)$/.test(key)) {
      const location = clean(val, 80)
      if (location) update.location = location
    } else if (/^(?:穿着|服装|穿搭|衣服|outfit|clothes)$/.test(key)) {
      const outfit = clean(val, 160)
      if (outfit) update.outfit = outfit
    }
  }
  return Object.keys(update).length ? update : null
}
