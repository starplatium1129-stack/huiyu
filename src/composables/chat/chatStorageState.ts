import { STORAGE_VERSION, MAX_LOCAL_MESSAGES, createMessageId } from '@/config/characters'
import { CLIPROXY_BASE_URL, CLIPROXY_API_KEY, CLIPROXY_DEFAULT_MODEL } from '@/config/chatApi'
import {
  DEFAULT_COMPANION_CHARACTER_ID,
  getCompanionDefaultOutfit,
  normalizeCompanionOutfit,
} from '@/utils/companionRegistry'
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
    settings: {
      model: '',
      provider: 'api',
      apiBaseUrl: CLIPROXY_BASE_URL,
      apiModel: CLIPROXY_DEFAULT_MODEL,
      apiKey: CLIPROXY_API_KEY,
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
