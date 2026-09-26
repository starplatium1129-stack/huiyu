import { profileLocalStorage as localStorage } from '../platform/web/profileStorage.ts'
import {
  AUTO_SAVE_TO_GALLERY_KEY,
  CHAT_THINKING_KEY,
  DRAW_ENGINE_KEY,
  GUEST_GUIDE_DISMISSED_KEY,
  INTERFACE_SOUND_KEY,
  THEME_KEY,
  TUNNEL_OFF_KEY,
} from '../utils/storageKeys.ts'

export type DrawEngine = 'sd' | 'anima' | 'krea2'
export type Theme = 'dark' | 'light'
export type ReasoningLevel = 'off' | 'low' | 'medium' | 'high'

export interface KeyedStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface SettingDefinition<T> {
  readonly key: string
  readonly parse: (raw: string | null) => T | null
  readonly serialize: (value: T) => string
}

export const DRAW_ENGINE_SETTING: SettingDefinition<DrawEngine> = {
  key: DRAW_ENGINE_KEY,
  parse(raw) {
    return raw === 'sd' || raw === 'anima' || raw === 'krea2' ? raw : null
  },
  serialize(value) {
    return value
  },
}

export const THEME_SETTING: SettingDefinition<Theme> = {
  key: THEME_KEY,
  parse(raw) { return raw === 'dark' || raw === 'light' ? raw : null },
  serialize(value) { return value },
}

export const INTERFACE_SOUND_SETTING: SettingDefinition<boolean> = {
  key: INTERFACE_SOUND_KEY,
  parse(raw) { return raw === '1' },
  serialize(value) { return value ? '1' : '0' },
}

/** The stored value is the historical "tunnel disabled" flag. */
export const TUNNEL_ENABLED_SETTING: SettingDefinition<boolean> = {
  key: TUNNEL_OFF_KEY,
  parse(raw) { return raw !== '1' },
  serialize(value) { return value ? '' : '1' },
}

export const GUEST_GUIDE_DISMISSED_SETTING: SettingDefinition<boolean> = {
  key: GUEST_GUIDE_DISMISSED_KEY,
  parse(raw) { return raw === '1' },
  serialize(value) { return value ? '1' : '0' },
}

/** 出图自动入册（2026-08-31 用户偏好：默认关，缺省即 false）。 */
export const AUTO_SAVE_TO_GALLERY_SETTING: SettingDefinition<boolean> = {
  key: AUTO_SAVE_TO_GALLERY_KEY,
  parse(raw) { return raw === '1' },
  serialize(value) { return value ? '1' : '0' },
}

export const CHAT_THINKING_SETTING: SettingDefinition<ReasoningLevel> = {
  key: CHAT_THINKING_KEY,
  parse(raw) {
    if (raw === '0' || raw === 'off') return 'off'
    return raw === 'low' || raw === 'medium' || raw === 'high' ? raw : null
  },
  serialize(value) { return value },
}

function browserStorage(): KeyedStorage | null {
  try {
    return typeof globalThis.localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export interface SettingsRepository {
  get<T>(definition: SettingDefinition<T>): T | null
  has<T>(definition: SettingDefinition<T>): boolean
  set<T>(definition: SettingDefinition<T>, value: T): void
  remove<T>(definition: Pick<SettingDefinition<T>, 'key'>): void
}

export function createSettingsRepository(storage?: KeyedStorage | null): SettingsRepository {
  const store = storage === undefined ? browserStorage() : storage
  return {
    get<T>(definition: SettingDefinition<T>): T | null {
      if (!store) return null
      try {
        return definition.parse(store.getItem(definition.key))
      } catch {
        return null
      }
    },
    has<T>(definition: SettingDefinition<T>): boolean {
      if (!store) return false
      try { return store.getItem(definition.key) !== null } catch { return false }
    },
    set<T>(definition: SettingDefinition<T>, value: T): void {
      if (!store) return
      try { store.setItem(definition.key, definition.serialize(value)) } catch { /* private mode */ }
    },
    remove<T>(definition: Pick<SettingDefinition<T>, 'key'>): void {
      if (!store) return
      try { store.removeItem(definition.key) } catch { /* private mode */ }
    },
  }
}

export const settingsRepository = createSettingsRepository()
