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

/** Read per-character tombstones with the legacy whole-history fallback. */
export function storedHistoryRevision(record: Record<string, unknown>, char: string): number {
  const parsedRevision = Number(record.historiesRevision)
  const legacyRevision = Number.isSafeInteger(parsedRevision) && parsedRevision >= 0 ? parsedRevision : 0
  const rawRevisions = record.historiesRevisions
  const remoteRevisions = rawRevisions && typeof rawRevisions === 'object'
    ? rawRevisions as Record<string, unknown>
    : {}
  const parsedCharRevision = Number(remoteRevisions[char])
  return Number.isSafeInteger(parsedCharRevision) && parsedCharRevision >= 0
    ? parsedCharRevision
    : legacyRevision
}
