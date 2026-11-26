import { profileLocalStorage as localStorage } from '@/platform/web/profileStorage'
import {
  EMPTY_CHAT_USER_PROFILE,
  loadChatUserProfile,
  normalizeChatUserProfile,
  saveChatUserProfile,
  type ChatUserProfile,
} from './chatUserProfile'
import { CHAT_USER_PERSONAS_KEY } from './storageKeys'

export interface UserPersona extends ChatUserProfile {
  id: string
  label: string
}

export interface UserPersonaStore {
  version: 1
  activeId: string
  characterBindings: Record<string, string>
  personas: UserPersona[]
}

function makePersonaId(): string {
  return `persona-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

function normalizePersona(raw: unknown, fallbackLabel = '未命名马甲'): UserPersona | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const base = normalizeChatUserProfile(r)
  const id = typeof r.id === 'string' && r.id.trim() ? r.id.trim().slice(0, 64) : makePersonaId()
  const rawLabel = typeof r.label === 'string' ? r.label.trim().slice(0, 32) : ''
  return {
    id,
    label: rawLabel || base.callName || fallbackLabel,
    ...base,
  }
}

export function loadUserPersonaStore(): UserPersonaStore {
  try {
    const raw = JSON.parse(localStorage.getItem(CHAT_USER_PERSONAS_KEY) || 'null') as Record<string, unknown> | null
    if (raw && typeof raw === 'object' && Array.isArray(raw.personas) && raw.personas.length) {
      const personas = raw.personas
        .map((item, idx) => normalizePersona(item, idx === 0 ? '默认马甲' : `马甲 ${idx + 1}`))
        .filter((item): item is UserPersona => Boolean(item))
        .slice(0, 30)
      if (personas.length) {
        const activeId = typeof raw.activeId === 'string' && personas.some(p => p.id === raw.activeId)
          ? raw.activeId
          : personas[0]!.id
        const rawBindings = raw.characterBindings && typeof raw.characterBindings === 'object' && !Array.isArray(raw.characterBindings)
          ? raw.characterBindings as Record<string, unknown>
          : {}
        const characterBindings: Record<string, string> = {}
        for (const [charId, pid] of Object.entries(rawBindings)) {
          if (typeof pid === 'string' && personas.some(p => p.id === pid)) {
            characterBindings[charId] = pid
          }
        }
        return { version: 1, activeId, characterBindings, personas }
      }
    }
  } catch { /* Migrate from legacy single profile. */ }

  const legacy = loadChatUserProfile()
  const defaultPersona: UserPersona = {
    id: 'persona-default',
    label: legacy.callName ? `${legacy.callName}（默认）` : '默认马甲',
    ...legacy,
  }
  return {
    version: 1,
    activeId: defaultPersona.id,
    characterBindings: {},
    personas: [defaultPersona],
  }
}

export function saveUserPersonaStore(store: UserPersonaStore): UserPersonaStore {
  const personas = (store.personas.length ? store.personas : [{
    id: 'persona-default',
    label: '默认马甲',
    ...EMPTY_CHAT_USER_PROFILE,
  }]).slice(0, 30).map((item, idx) => ({
    id: item.id || makePersonaId(),
    label: (item.label || item.callName || `马甲 ${idx + 1}`).trim().slice(0, 32),
    ...normalizeChatUserProfile(item),
  }))
  const activeId = personas.some(p => p.id === store.activeId) ? store.activeId : personas[0]!.id
  const characterBindings: Record<string, string> = {}
  for (const [charId, pid] of Object.entries(store.characterBindings || {})) {
    if (personas.some(p => p.id === pid)) {
      characterBindings[charId] = pid
    }
  }
  const normalized: UserPersonaStore = {
    version: 1,
    activeId,
    characterBindings,
    personas,
  }
  localStorage.setItem(CHAT_USER_PERSONAS_KEY, JSON.stringify(normalized))
  const active = personas.find(p => p.id === activeId) || personas[0]!
  saveChatUserProfile(active)
  return normalized
}

export function createBlankPersona(label = '新马甲'): UserPersona {
  return {
    id: makePersonaId(),
    label: label.trim().slice(0, 32) || '新马甲',
    ...EMPTY_CHAT_USER_PROFILE,
  }
}

export function resolvePersonaForCharacter(characterId: string): UserPersona {
  const store = loadUserPersonaStore()
  const boundId = store.characterBindings[characterId]
  if (boundId) {
    const found = store.personas.find(p => p.id === boundId)
    if (found) return found
  }
  return store.personas.find(p => p.id === store.activeId) || store.personas[0]!
}

export function getBoundPersonaId(characterId: string): string {
  const store = loadUserPersonaStore()
  return store.characterBindings[characterId] || ''
}

export function toChatUserProfile(persona: UserPersona): ChatUserProfile {
  return normalizeChatUserProfile(persona)
}
