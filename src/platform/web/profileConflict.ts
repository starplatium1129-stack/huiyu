import { mergeHistories } from '../../composables/chat/chatStorageMerge.ts'
import { mergeChatArchives, normalizeChatArchive } from '../../utils/chatArchive.ts'
import { assertChatVersion } from '../../utils/chatVersion.ts'
import type { ChatMessage } from '../../composables/chat/chatStorageTypes'

type RecordBody = Record<string, unknown>
const object = (value: unknown): RecordBody => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordBody : {}
const decode = (value: unknown): RecordBody => object(typeof value === 'string' ? JSON.parse(value) : value)
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
function changedFields(base: RecordBody, local: RecordBody, remote: RecordBody): RecordBody {
  const result = { ...remote }
  for (const key of new Set([...Object.keys(base), ...Object.keys(local)])) {
    if (equal(base[key], local[key])) continue
    if (Object.hasOwn(local, key)) result[key] = local[key]; else delete result[key]
  }
  return result
}
export function mergeProfileSettingConflict(baseValue: unknown, localValue: unknown, remoteValue: unknown): unknown {
  if (localValue === null) return null
  try {
    const base = typeof baseValue === 'string' ? JSON.parse(baseValue) : baseValue
    const local = typeof localValue === 'string' ? JSON.parse(localValue) : localValue
    const remote = typeof remoteValue === 'string' ? JSON.parse(remoteValue) : remoteValue
    if (!local || typeof local !== 'object' || Array.isArray(local)) return localValue
    const value = changedFields(object(base), object(local), object(remote))
    return typeof localValue === 'string' ? JSON.stringify(value) : value
  } catch { return localValue }
}

/** Rebase only a definitively rejected revision, preserving the existing message
 * merge and clear revisions. Network-unknown writes never enter this function. */
export async function mergeProfileChatConflict(key: string, baseValue: unknown, localValue: unknown, remoteValue: unknown): Promise<unknown> {
  if (localValue === null) return null
  const base = decode(baseValue), local = decode(localValue), remote = decode(remoteValue)
  let merged = changedFields(base, local, remote)
  if (key === 'aics_chat_v1') {
    for (const value of [base, local, remote]) assertChatVersion(value, 3)
    const histories: RecordBody = {}, revisions: RecordBody = {}
    const localHistory = object(local.histories), remoteHistory = object(remote.histories), baseHistory = object(base.histories)
    const chars = new Set([...Object.keys(localHistory), ...Object.keys(remoteHistory)])
    for (const char of chars) {
      const before = Number(object(base.historiesRevisions)[char] ?? base.historiesRevision) || 0
      const own = Number(object(local.historiesRevisions)[char] ?? local.historiesRevision) || 0
      const other = Number(object(remote.historiesRevisions)[char] ?? remote.historiesRevision) || 0
      const ownMessages = Array.isArray(localHistory[char]) ? localHistory[char] as ChatMessage[] : []
      const otherMessages = Array.isArray(remoteHistory[char]) ? remoteHistory[char] as ChatMessage[] : []
      revisions[char] = Math.max(own, other)
      if (other > own && other > before) histories[char] = otherMessages
      else if (own > other && own > before) histories[char] = ownMessages
      else {
        const baseline = Array.isArray(baseHistory[char]) ? baseHistory[char] as ChatMessage[] : []
        histories[char] = mergeHistories(ownMessages, otherMessages, new Map(baseline.map(message => [message.mid, JSON.stringify(message)])))
      }
    }
    const settings = changedFields(object(base.settings), object(local.settings), object(remote.settings))
    for (const field of ['drafts', 'live2dOutfits']) settings[field] = changedFields(object(object(base.settings)[field]), object(object(local.settings)[field]), object(object(remote.settings)[field]))
    merged = { ...merged, histories, historiesRevisions: revisions, historiesRevision: Math.max(Number(local.historiesRevision) || 0, Number(remote.historiesRevision) || 0), settings }
  } else if (key === 'aics_chat_archive_v1') {
    const ids = [...new Set([...Object.keys(object(local.archived)), ...Object.keys(object(remote.archived))])]
    const own = normalizeChatArchive(local, ids), other = normalizeChatArchive(remote, ids)
    const archive = mergeChatArchives(other, own)
    for (const id of ids) {
      const before = object(base.revisions)[id] || '', ownReset = own.revisions?.[id] || '', remoteReset = other.revisions?.[id] || ''
      if (remoteReset !== before) { archive.archived[id] = other.archived[id]; archive.revisions![id] = remoteReset }
      else if (ownReset !== before) { archive.archived[id] = own.archived[id]; archive.revisions![id] = ownReset }
    }
    merged = { ...merged, ...archive }
  } else if (key === 'aics_chat_memories_v1') {
    const { mergeChatMemoryStates, normalizeChatMemoryState } = await import('../../utils/chatMemory.ts')
    const own = normalizeChatMemoryState(local), other = normalizeChatMemoryState(remote)
    const memory = mergeChatMemoryStates(other, own)
    for (const [char, items] of Object.entries(memory.byCharacter)) {
      const baseline = object(base.byCharacter)[char]
      const before = new Map((Array.isArray(baseline) ? baseline : []).map(item => [String(item.id), item]))
      const ownIds = new Set((own.byCharacter[char] || []).map(item => item.id)), remoteIds = new Set((other.byCharacter[char] || []).map(item => item.id))
      memory.byCharacter[char] = items.filter(item => !before.has(item.id) || (ownIds.has(item.id) && (remoteIds.has(item.id) || !equal(item, before.get(item.id)))))
    }
    merged = { ...merged, ...memory }
  }
  return typeof localValue === 'string' ? JSON.stringify(merged) : merged
}
