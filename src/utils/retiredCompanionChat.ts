import { profileLocalStorage as localStorage } from '../platform/web/profileStorage.ts'
import { RETIRED_COMPANION_CHAT_KEY, CHAT_MEMORY_KEY } from './storageKeys'
import { CHAT_ARCHIVE_KEY } from './chatArchive'

/** Removing a model must not erase conversations on the next whitelist save. */
export function preserveRetiredCompanionChat(raw: unknown) {
  const state = raw as { histories?: Record<string, unknown>; settings?: { drafts?: Record<string, unknown> } } | null
  const history = state?.histories?.raiden_shogun
  const draft = state?.settings?.drafts?.raiden_shogun
  if (!Array.isArray(history) && typeof draft !== 'string') return
  const previous = JSON.parse(localStorage.getItem(RETIRED_COMPANION_CHAT_KEY) || '{}')
  let memories: unknown
  let archive: unknown
  try { memories = JSON.parse(localStorage.getItem(CHAT_MEMORY_KEY) || '{}').byCharacter?.raiden_shogun } catch { /* Keep the original memory store untouched. */ }
  try { archive = JSON.parse(localStorage.getItem(CHAT_ARCHIVE_KEY) || '{}').archived?.raiden_shogun } catch { /* Keep the original archive untouched. */ }
  // Persist before normalization; a failed write aborts load's save path.
  localStorage.setItem(RETIRED_COMPANION_CHAT_KEY, JSON.stringify({ ...previous, raiden_shogun: { ...previous?.raiden_shogun, history, draft, memories, ...(archive ? { archive } : {}) } }))
}
