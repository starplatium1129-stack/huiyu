import { CHAT_DRAFT_PREFIX, CHAT_MEMORY_KEY, CHAT_USER_PROFILE_KEY, RETIRED_COMPANION_CHAT_KEY, CHAT_RESET_KEY } from './storageKeys.ts'
import { assertStoredChatVersion } from './chatVersion.ts'

export function chatResetRevision(): string { return localStorage.getItem(CHAT_RESET_KEY) || '' }

/** Exact content ownership; configuration, credentials and artwork are retained. */
export async function clearStoredChatContent(): Promise<{ failed: string[] }> {
  const { readChatArchive, withChatArchiveMutation, writeChatArchive } = await import('../storage/chatArchiveRepository')
  return withChatArchiveMutation(async () => {
    assertStoredChatVersion('aics_chat_v1', 3)
    assertStoredChatVersion('aics_chat_archive_v1', 1)
    assertStoredChatVersion(CHAT_MEMORY_KEY, 1)
    const archive = await readChatArchive()
    const failed: string[] = []
    // Publish the tombstone first; if this fails nothing is deleted.
    localStorage.setItem(CHAT_RESET_KEY, `${Date.now()}-${crypto.randomUUID()}`)
    archive.revisions ||= {}
    for (const id of Object.keys(archive.archived)) {
      archive.archived[id] = []
      archive.revisions[id] = crypto.randomUUID()
    }
    try { await writeChatArchive(archive) } catch { failed.push('聊天归档') }
    const keys = [CHAT_MEMORY_KEY, CHAT_USER_PROFILE_KEY, RETIRED_COMPANION_CHAT_KEY, 'aics_chat_archive_v1']
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key?.startsWith(CHAT_DRAFT_PREFIX)) keys.push(key)
    }
    try {
      const raw = JSON.parse(localStorage.getItem('aics_chat_v1') || '{}')
      raw.historiesRevision = Math.max(Number(raw.historiesRevision) + 1 || 1, Date.now())
      raw.histories = {}
      raw.historiesRevisions = {}
      if (raw.settings) raw.settings.drafts = {}
      localStorage.setItem('aics_chat_v1', JSON.stringify(raw))
    } catch { failed.push('对话及旧草稿') }
    for (const key of keys) {
      try { localStorage.removeItem(key) } catch { failed.push(key) }
    }
    return { failed }
  })
}
