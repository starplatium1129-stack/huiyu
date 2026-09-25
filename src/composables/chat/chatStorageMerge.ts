import type { ChatMessage } from './chatStorageTypes'

/** Merge by mid while preserving references held by active streaming callbacks. */
export function mergeHistories(
  local: ChatMessage[],
  remote: ChatMessage[],
  snapshots: Map<string, string>,
): ChatMessage[] {
  const localById = new Map(local.map(message => [message.mid, message]))
  const seen = new Set<string>()
  const merged: ChatMessage[] = []
  for (const message of [...remote, ...local]) {
    if (!message || typeof message.mid !== 'string' || !message.mid) continue
    if (seen.has(message.mid)) continue
    seen.add(message.mid)
    const existing = localById.get(message.mid)
    if (existing && snapshots.get(message.mid) === JSON.stringify(existing)) {
      Object.assign(existing, message)
      snapshots.set(message.mid, JSON.stringify(existing))
    } else if (!existing) {
      snapshots.set(message.mid, JSON.stringify(message))
    }
    merged.push(existing || message)
  }
  return merged
}
