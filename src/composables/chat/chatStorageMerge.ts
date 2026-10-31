import type { ChatMessage } from './chatStorageTypes'
import { applyReplyVariant, chatMessageKey, cloneChatMessages, mergeReplyVariants, replySnapshot } from '@/utils/chatMessageStorage'

/** Merge reply groups and their independent candidates while preserving live streaming references. */
export function mergeHistories(
  local: ChatMessage[],
  remote: ChatMessage[],
  snapshots: Map<string, string>,
): ChatMessage[] {
  const localById = new Map(local.map(message => [chatMessageKey(message), message]))
  const remoteById = new Map(remote.map(message => [chatMessageKey(message), message]))
  const seen = new Set<string>()
  const merged: ChatMessage[] = []
  const ordered = remote.every(message => localById.has(chatMessageKey(message))) ? [...local, ...remote] : [...remote, ...local]
  for (const item of ordered) {
    const message = remoteById.get(chatMessageKey(item)) || item
    if (!message || typeof message.mid !== 'string' || !message.mid) continue
    const key = chatMessageKey(message)
    if (seen.has(key)) continue
    seen.add(key)
    const existing = localById.get(key)
    if (existing) {
      // A remote reload falls back to the last completed candidate. It must not
      // replace the new live candidate while it is waiting for its first token.
      const awaitingVariant = existing.role === 'assistant' && !existing.content
        && existing.variants?.length && !existing.variants.some(variant => variant.mid === existing.mid)
      const unchanged = !awaitingVariant && snapshots.get(key) === JSON.stringify(existing)
      const variants = existing.role === 'assistant' && (existing.variants?.length || message.variants?.length || existing.mid !== message.mid)
        ? mergeReplyVariants(message.variants || [], [replySnapshot(message)], existing.variants || [], [replySnapshot(existing)]) : []
      if (unchanged) applyReplyVariant(existing, message)
      if (variants.length) { existing.replyId ||= message.replyId || key; existing.variants = mergeReplyVariants(variants, [replySnapshot(existing)]) }
      if (unchanged) snapshots.set(key, JSON.stringify(existing))
    } else if (!existing) {
      snapshots.set(key, JSON.stringify(message))
    }
    merged.push(existing || cloneChatMessages([message])[0])
  }
  return merged
}
