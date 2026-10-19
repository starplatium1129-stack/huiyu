import { STORAGE_VERSION, MAX_LOCAL_MESSAGES, createMessageId } from '@/config/characters'
import { DEFAULT_CHAT_API_BASE_URL, DEFAULT_CHAT_API_MODEL } from '@/config/chatApi'
import {
  DEFAULT_COMPANION_CHARACTER_ID,
  getCompanionDefaultOutfit,
  normalizeCompanionOutfit,
} from '@/utils/companionRegistry'
import { emptyChatConversation } from '@/utils/chatConversationStorage'
import type { ChatState } from './chatStorageTypes'

export function createChatStorageState(characterIds: string[]): ChatState {
  const defaultCharacterId = characterIds[0] || DEFAULT_COMPANION_CHARACTER_ID
  const defaultOutfits = Object.fromEntries(characterIds.map(id => [id, getCompanionDefaultOutfit(id)]))
  return {
    version: STORAGE_VERSION,
    historiesRevision: 0,
    historiesRevisions: Object.fromEntries(characterIds.map(id => [id, 0])),
    active: defaultCharacterId,
    histories: Object.fromEntries(characterIds.map(id => [id, []])),
    conversations: Object.fromEntries(characterIds.map(id => [id, emptyChatConversation()])),
    settings: {
      model: '',
      provider: 'api',
      apiBaseUrl: DEFAULT_CHAT_API_BASE_URL,
      apiModel: DEFAULT_CHAT_API_MODEL,
      apiKey: '',
      webSearchEnabled: false,
      live2dEnabled: false,
      live2dOutfit: defaultOutfits[defaultCharacterId] || '',
      live2dOutfits: defaultOutfits,
      autoVoice: true,
      volume: 80,
      drafts: Object.fromEntries(characterIds.map(id => [id, ''])),
    },
  }
}

export function createChatNormalizeOptions(characterIds: string[]) {
  return {
    characterIds,
    maxMessages: MAX_LOCAL_MESSAGES,
    version: STORAGE_VERSION,
    createMessageId,
    normalizeOutfit: normalizeCompanionOutfit,
  }
}
