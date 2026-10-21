import { profileLocalStorage, writeProfileLocal, type ProfileWriteReceipt } from '@/platform/web/profileStorage'
import { CHAT_PREFERENCES_KEY } from '@/utils/storageKeys'
import { normalizeChatConnection, type ChatStorageOptions } from '@/utils/chatStorageCore'
import { STORAGE_VERSION } from '@/config/characters'
import type { ChatState } from '@/composables/chat/chatStorageTypes'

import { parseChatPreferences, chatPreferencesFromState, type ChatPreferences } from '@/utils/chatPreferencesCore'
export type { ChatPreferences } from '@/utils/chatPreferencesCore'
export function readChatPreferences(): ChatPreferences | null {
  const raw = profileLocalStorage.getItem(CHAT_PREFERENCES_KEY)
  return raw === null ? null : parseChatPreferences(JSON.parse(raw))
}

export function createChatPreferences(state: ChatState, options: ChatStorageOptions, onError: (message: string) => void) {
  let receipt: ProfileWriteReceipt | undefined
  const connection = (legacy: () => unknown) => {
    const stored = readChatPreferences()
    return normalizeChatConnection(stored ? { version: STORAGE_VERSION, active: stored.active, settings: stored } : legacy(), profileLocalStorage.getItem('aics_chat_model'), options)
  }
  function overlay(legacy: unknown) {
    const stored = readChatPreferences()
    if (!stored) return legacy
    const raw = legacy && typeof legacy === 'object' ? legacy as Record<string, unknown> : {}
    const old = raw.settings && typeof raw.settings === 'object' ? raw.settings as Record<string, unknown> : {}
    // A legacy credential belongs only to its original endpoint, never a newer preference binding.
    const previous = normalizeChatConnection(raw, '', options)
    const api = raw.api && typeof raw.api === 'object' ? raw.api as Record<string, unknown> : {}
    const key = previous.apiBaseUrl === stored.apiBaseUrl && previous.apiSettingsRevision === stored.apiSettingsRevision
      ? old.apiKey || raw.apiKey || api.apiKey || '' : ''
    return { ...raw, api: undefined, apiKey: undefined, active: stored.active, settings: { ...old, ...stored, apiKey: key } }
  }
  function save(patch: Partial<ChatPreferences>, configured: boolean, apiRevision: string): ProfileWriteReceipt {
    const current = readChatPreferences() || chatPreferencesFromState(state, configured, apiRevision)
    const next = { ...current, ...patch, live2dOutfits: { ...current.live2dOutfits, ...patch.live2dOutfits } }
    const written = receipt = writeProfileLocal(CHAT_PREFERENCES_KEY, JSON.stringify(next))
    void written.confirm().catch(() => { if (receipt === written) onError('聊天偏好尚未保存，请保留窗口并恢复资料连接后重试。') })
    return written
  }
  return { connection, overlay, save, confirm: () => receipt?.confirm() }
}
