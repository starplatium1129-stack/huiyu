import { profileLocalStorage as localStorage } from '../platform/web/profileStorage.ts'
import { CHAT_USER_PROFILE_KEY } from './storageKeys.ts'

export type ChatRelationship = 'atelier_owner' | 'friend' | 'confidant' | 'lover'

export interface ChatUserProfile {
  callName: string
  relationship: ChatRelationship
  note: string
}

export const CHAT_RELATIONSHIPS: ReadonlyArray<{ id: ChatRelationship; label: string }> = [
  { id: 'atelier_owner', label: '工坊主人' },
  { id: 'friend', label: '朋友' },
  { id: 'confidant', label: '知己' },
  { id: 'lover', label: '恋人' },
]

export const EMPTY_CHAT_USER_PROFILE: ChatUserProfile = {
  callName: '',
  relationship: 'atelier_owner',
  note: '',
}

function clean(value: unknown, maxLength: number): string {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength)
}

export function normalizeChatUserProfile(value: unknown): ChatUserProfile {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  const relationship = CHAT_RELATIONSHIPS.some(option => option.id === record.relationship)
    ? record.relationship as ChatRelationship
    : 'atelier_owner'
  return {
    callName: clean(record.callName, 40),
    relationship,
    note: clean(record.note, 200),
  }
}

export function hasChatUserProfile(profile: ChatUserProfile): boolean {
  return Boolean(profile.callName || profile.note || profile.relationship !== 'atelier_owner')
}

export function loadChatUserProfile(): ChatUserProfile {
  try {
    return normalizeChatUserProfile(JSON.parse(localStorage.getItem(CHAT_USER_PROFILE_KEY) || 'null'))
  } catch {
    return { ...EMPTY_CHAT_USER_PROFILE }
  }
}

export function saveChatUserProfile(profile: ChatUserProfile): ChatUserProfile {
  const normalized = normalizeChatUserProfile(profile)
  localStorage.setItem(CHAT_USER_PROFILE_KEY, JSON.stringify(normalized))
  return normalized
}
