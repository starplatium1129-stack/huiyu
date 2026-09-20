import { CHAT_DRAFT_PREFIX, CHAT_MEMORY_KEY, CHAT_VOLUME_KEY, isLiveLocalKey } from './storageKeys'
import { CHAT_ARCHIVE_KEY, mergeChatArchives, normalizeChatArchive, serializeChatArchive } from './chatArchive'
import { mergeChatMemoryStates, normalizeChatMemoryState } from './chatMemory'
import { normalizeChatStorage } from './chatStorageCore'
import { listCompanionCharacterIds, normalizeCompanionOutfit } from './companionRegistry'

/** Validate and merge settings in memory before touching the user's existing storage. */
export function prepareBackupSettings(current: Record<string, string>, incoming: Record<string, string>, replace: boolean) {
  const characterIds = listCompanionCharacterIds()
  const result = replace ? {} as Record<string, string> : { ...current }
  for (const [key, value] of Object.entries(incoming)) {
    if (!isLiveLocalKey(key)) continue
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
        maxMessages: 20,
        version: 3,
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
      const merged = { ...next, histories: { ...old.histories } }
      for (const character of options.characterIds) {
        const ids = new Set<string>()
        merged.histories[character] = [...old.histories[character], ...next.histories[character]].filter(item => {
          if (ids.has(item.mid)) return false
          ids.add(item.mid)
          return true
        }).slice(-20)
      }
      result[key] = JSON.stringify(merged)
    } else result[key] = value
  }
  return result
}
