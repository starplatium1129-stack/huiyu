import type { ChatState } from './chatStorageTypes'
import { emptyChatConversation, projectChatConversations } from '@/utils/chatConversationStorage'
import { normalizeChatStorage, type ChatStorageOptions, type PersistedChatState } from '@/utils/chatStorageCore'

/** Legacy preferences are retained for old imports; only the separate preference record advances them. */
export function chatHistorySnapshot(state: ChatState, legacy: string | null, options: ChatStorageOptions, characters?: string[]): PersistedChatState {
  const previous = JSON.parse(legacy || '{}')
  const metadata = normalizeChatStorage({ ...previous, histories: {}, conversations: {} }, '', options).state
  metadata.settings.apiSettingsRevision = typeof previous?.settings?.apiSettingsRevision === 'string' ? previous.settings.apiSettingsRevision.slice(0, 80) : ''
  const selected = new Set(characters || options.characterIds)
  const histories = Object.fromEntries(options.characterIds.map(char => [char, selected.has(char) ? state.histories[char] : previous?.histories?.[char] || []]))
  const conversations = Object.fromEntries(options.characterIds.filter(char => !selected.has(char))
    .map(char => [char, previous?.conversations?.[char] || emptyChatConversation(histories[char])]))
  Object.assign(conversations, projectChatConversations(state, [...selected]))
  return { version: state.version, historiesRevision: state.historiesRevision, historiesRevisions: { ...state.historiesRevisions },
    histories, conversations, active: metadata.active, settings: metadata.settings }
}
