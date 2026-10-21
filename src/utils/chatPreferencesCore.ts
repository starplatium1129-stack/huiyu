import type { PersistedChatState } from './chatStorageCore'
import type { ChatState } from '@/composables/chat/chatStorageTypes'

type Settings = Omit<PersistedChatState['settings'], 'apiKey' | 'drafts' | 'volume' | 'live2dOutfit'>
export type ChatPreferences = Settings & { version: 1; active: string }
const texts = ['active', 'model', 'provider', 'apiBaseUrl', 'apiModel', 'apiSettingsRevision'] as const
const flags = ['apiConfiguredByUser', 'webSearchEnabled', 'live2dEnabled', 'autoVoice'] as const
export function parseChatPreferences(input: unknown): ChatPreferences {
  const value = input as ChatPreferences
  if (!value || value.version !== 1 || texts.some(key => typeof value[key] !== 'string' || value[key]!.length > 2000)
    || flags.some(key => typeof value[key] !== 'boolean') || !['local', 'api'].includes(value.provider)
    || !value.live2dOutfits || typeof value.live2dOutfits !== 'object' || Array.isArray(value.live2dOutfits)
    || Object.values(value.live2dOutfits).some(value => typeof value !== 'string' || value.length > 80))
    throw new Error('聊天偏好版本不兼容或内容损坏，原记录已保留')
  // Secret fields are never part of this record, including restored/foreign input.
  return { ...Object.fromEntries(['version', ...texts, ...flags].map(key => [key, value[key as keyof ChatPreferences]])),
    live2dOutfits: { ...value.live2dOutfits } } as ChatPreferences
}
export function chatPreferencesFromState(state: Pick<ChatState, 'active' | 'settings'>, configured: boolean, revision = ''): ChatPreferences {
  return parseChatPreferences({ ...state.settings, version: 1, active: state.active, apiConfiguredByUser: configured, apiSettingsRevision: revision })
}
