import { CHAT_DRAFT_PREFIX, CHAT_MEMORY_KEY, CHAT_VOLUME_KEY, isLiveLocalKey } from './storageKeys'
import { CHAT_ARCHIVE_KEY, mergeChatArchives, normalizeChatArchive, serializeChatArchive } from './chatArchive'
import { mergeChatMemoryStates, normalizeChatMemoryState } from './chatMemory'
import { normalizeChatStorage } from './chatStorageCore'
import { listCompanionCharacterIds, normalizeCompanionOutfit } from './companionRegistry'
import { assertChatVersion } from './chatVersion'
import { STORAGE_VERSION } from '@/config/characters'
import { captureChatConversations, mergeChatConversationStates } from './chatConversationStorage'
import { cloneChatMessages } from './chatMessageStorage'

/** Validate and merge settings in memory before touching the user's existing storage. */
export function prepareBackupSettings(current: Record<string, string>, incoming: Record<string, string>, replace: boolean) {
  const characterIds = listCompanionCharacterIds()
  // Merge mode returns only keys supplied by the backup (plus explicit legacy
  // companion preferences it must promote). Returning the whole current snapshot
  // would make a later restore write stale values from before an async image stage.
  const result = {} as Record<string, string>
  if (replace) for (const [key, version] of [['aics_chat_v1', STORAGE_VERSION], [CHAT_MEMORY_KEY, 1], [CHAT_ARCHIVE_KEY, 1]] as const) {
    assertChatVersion(JSON.parse(current[key] || 'null'), version)
  }
  for (const [key, value] of Object.entries(incoming)) {
    if (!isLiveLocalKey(key)) continue
    const version = key === 'aics_chat_v1' ? STORAGE_VERSION : [CHAT_MEMORY_KEY, CHAT_ARCHIVE_KEY].includes(key) ? 1 : 0
    if (version) {
      assertChatVersion(JSON.parse(current[key] || 'null'), version)
      assertChatVersion(JSON.parse(value), version)
    }
    if (!replace && key === CHAT_MEMORY_KEY) {
      result[key] = JSON.stringify(mergeChatMemoryStates(
        normalizeChatMemoryState(JSON.parse(current[key] || 'null')),
        normalizeChatMemoryState(JSON.parse(value)),
      ))
    } else if (!replace && key === CHAT_ARCHIVE_KEY) {
      result[key] = serializeChatArchive(mergeChatArchives(
        normalizeChatArchive(JSON.parse(current[key] || 'null'), characterIds),
        normalizeChatArchive(JSON.parse(value), characterIds),
      ))
    } else if (!replace && key === 'aics_chat_v1') {
      const options = {
        characterIds,
        maxMessages: Number.MAX_SAFE_INTEGER,
        version: STORAGE_VERSION,
        createMessageId: () => `restore-${crypto.randomUUID()}`,
        normalizeOutfit: normalizeCompanionOutfit,
      }
      const old = normalizeChatStorage(JSON.parse(current[key] || 'null'), '', options).state
      const next = normalizeChatStorage(JSON.parse(value), '', options).state
      // Older backups keep these values inside the chat record. Promote them
      // so existing separate preferences cannot mask the restored settings.
      if (!(CHAT_VOLUME_KEY in incoming)) result[CHAT_VOLUME_KEY] = String(next.settings.volume)
      for (const character of characterIds) {
        const draftKey = CHAT_DRAFT_PREFIX + character
        if (!(draftKey in incoming)) result[draftKey] = JSON.stringify(next.settings.drafts[character] || '')
      }
      // A portable import adds branches and alternatives; local clear epochs
      // do not discard a deliberately selected backup's conversation content.
      const merged = { ...next, histories: cloneChatMessagesByCharacter(old.histories), conversations: captureChatConversations(old),
        historiesRevision: old.historiesRevision, historiesRevisions: { ...old.historiesRevisions } }
      for (const character of characterIds) next.historiesRevisions[character] = merged.historiesRevisions[character] || 0
      next.historiesRevision = merged.historiesRevision
      mergeChatConversationStates(merged, next)
      merged.conversations = captureChatConversations(merged)
      result[key] = JSON.stringify(merged)
    } else result[key] = value
  }
  return result
}

function cloneChatMessagesByCharacter(histories: Record<string, import('./chatStorageCore').PersistedChatMessage[]>) {
  return Object.fromEntries(Object.entries(histories).map(([char, messages]) => [char, cloneChatMessages(messages)]))
}
