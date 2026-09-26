import { profileLocalStorage as localStorage } from '../platform/web/profileStorage.ts'
import { kvGet, kvSet } from '@/composables/useKVStore'
import { CHAT_ARCHIVE_KEY, normalizeChatArchive, type ChatArchive } from '@/utils/chatArchive'
import { listCompanionCharacterIds } from '@/utils/companionRegistry'
import { profileRuntimeActive, readProfileChatArchive, writeProfileChatArchive } from '../platform/web/profileStorage.ts'

import { CHAT_ARCHIVE_CHANGED_KEY, CHAT_ARCHIVE_KV_KEY } from '@/utils/storageKeys'
export { CHAT_ARCHIVE_KV_KEY } from '@/utils/storageKeys'

export async function withChatArchiveMutation<T>(work: () => Promise<T>): Promise<T> {
  if (!navigator.locks?.request) return Promise.reject(new Error('当前浏览器不支持安全的多窗口归档保存，请使用桌面版或新版浏览器。'))
  return await navigator.locks.request(CHAT_ARCHIVE_KEY, work)
}

/** IndexedDB is authoritative once committed. The legacy record is only a migration
 * source; never merge it back after a clear. Backups still use the portable v1 JSON.
 */
export async function readChatArchive(characterIds = listCompanionCharacterIds()): Promise<ChatArchive> {
  const stored = profileRuntimeActive() ? await readProfileChatArchive() : await kvGet(CHAT_ARCHIVE_KV_KEY)
  if (stored !== null && (typeof stored !== 'object' || Array.isArray(stored))) throw new Error('聊天归档格式异常，原件已保留。')
  if (stored !== null && !Object.hasOwn(stored, 'archived')) throw new Error('聊天归档结构不完整，原件已保留。')
  if (stored !== null) return normalizeChatArchive(stored, characterIds)
  const legacyText = localStorage.getItem(CHAT_ARCHIVE_KEY)
  const legacy: unknown = legacyText === null ? null : JSON.parse(legacyText)
  if (legacyText !== null && legacy === null) throw new Error('聊天归档格式损坏，原件已保留。')
  return normalizeChatArchive(legacy, characterIds)
}

/** Caller holds the archive lock, including backup restore and global reset. */
export async function writeChatArchive(archive: ChatArchive): Promise<void> {
  if (profileRuntimeActive()) { await writeProfileChatArchive(archive); return }
  await kvSet(CHAT_ARCHIVE_KV_KEY, archive)
  try { localStorage.removeItem(CHAT_ARCHIVE_KEY) } catch { /* The IDB record prevents legacy replay. */ }
  // Invalidation only. Other pages reload IndexedDB rather than trusting this cache.
  try { localStorage.setItem(CHAT_ARCHIVE_CHANGED_KEY, crypto.randomUUID()) } catch { /* Durable commit already succeeded. */ }
}
