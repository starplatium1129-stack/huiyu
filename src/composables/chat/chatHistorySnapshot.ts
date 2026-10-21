import type { ChatState } from './chatStorageTypes'
import { captureChatConversations } from '@/utils/chatConversationStorage'
import { normalizeChatStorage, type ChatStorageOptions, type PersistedChatState } from '@/utils/chatStorageCore'

/** Legacy preferences are retained for old imports; only the separate preference record advances them. */
export function chatHistorySnapshot(state: ChatState, legacy: string | null, options: ChatStorageOptions): PersistedChatState {
  const previous = JSON.parse(legacy || '{}')
  const metadata = normalizeChatStorage({ ...previous, histories: {}, conversations: {} }, '', options).state
  metadata.settings.apiSettingsRevision = typeof previous?.settings?.apiSettingsRevision === 'string' ? previous.settings.apiSettingsRevision.slice(0, 80) : ''
  return { version: state.version, historiesRevision: state.historiesRevision, historiesRevisions: { ...state.historiesRevisions },
    histories: state.histories, conversations: captureChatConversations(state), active: metadata.active, settings: metadata.settings }
}
