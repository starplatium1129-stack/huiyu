import type { ChatConversation, ChatMessage, ChatState } from '@/composables/chat/chatStorageTypes'
import { mergeHistories } from '@/composables/chat/chatStorageMerge'
import { chatMessageKey, cloneChatMessages, normalizeChatMessages } from './chatMessageStorage'

const object = (value: unknown): Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
const text = (value: unknown, max: number) => typeof value === 'string' ? value.trim().slice(0, max) : ''
const revision = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0
export function emptyChatConversation(messages: ChatMessage[] = []): ChatConversation {
  return { activeId: 'main', selectionRevision: 0, branches: [{ id: 'main', name: '主线', createdAt: 0, messages: cloneChatMessages(messages) }] }
}
export function normalizeChatConversations(value: unknown, histories: Record<string, ChatMessage[]>, ids: string[], createId: () => string) {
  const conversations: Record<string, ChatConversation> = {}, raw = object(value)
  for (const char of ids) {
    const source = object(raw[char]), conversation = emptyChatConversation(histories[char] || [])
    if (Array.isArray(source.branches)) {
      const seen = new Set<string>()
      for (const item of source.branches) {
        const branch = object(item), id = text(branch.id, 160)
        if (!id || seen.has(id)) continue
        seen.add(id)
        const parsed = { id, name: text(branch.name, 80) || (id === 'main' ? '主线' : '剧情分支'), createdAt: revision(branch.createdAt),
          ...(text(branch.parentId, 160) ? { parentId: text(branch.parentId, 160) } : {}),
          ...(text(branch.forkMessageId, 160) ? { forkMessageId: text(branch.forkMessageId, 160) } : {}),
          messages: normalizeChatMessages(branch.messages, Number.MAX_SAFE_INTEGER, createId) }
        if (id === 'main') conversation.branches[0] = parsed; else conversation.branches.push(parsed)
      }
    }
    const active = text(source.activeId, 160)
    conversation.activeId = conversation.branches.some(branch => branch.id === active) ? active : 'main'
    conversation.selectionRevision = revision(source.selectionRevision)
    // The legacy/live projection is authoritative for the selected branch.
    conversation.branches.find(branch => branch.id === conversation.activeId)!.messages = cloneChatMessages(histories[char] || [])
    conversations[char] = conversation
  }
  return conversations
}
type ConversationState = Pick<ChatState, 'conversations' | 'histories' | 'historiesRevision' | 'historiesRevisions'>
/** Borrow messages only for synchronous encoding; never publish this projection as mutable state. */
export function projectChatConversations(state: Pick<ChatState, 'conversations' | 'histories'>, characters = Object.keys(state.histories)): Record<string, ChatConversation> {
  return Object.fromEntries(characters.map(char => {
    const conversation = state.conversations[char] || emptyChatConversation()
    return [char, { ...conversation, branches: conversation.branches.map(branch => ({ ...branch,
      messages: branch.id === conversation.activeId ? state.histories[char] || [] : branch.messages })) }]
  }))
}
export function captureChatConversations(state: Pick<ChatState, 'conversations' | 'histories'>, characters?: string[]): Record<string, ChatConversation> {
  return JSON.parse(JSON.stringify(projectChatConversations(state, characters))) as Record<string, ChatConversation>
}
/** Every branch merges independently. A switch never mixes its old continuation into the new branch. */
export function mergeChatConversationStates(local: ConversationState, remote: ConversationState, snapshots = new Map<string, string>()) {
  const own = captureChatConversations(local), other = captureChatConversations(remote)
  for (const char of new Set([...Object.keys(own), ...Object.keys(other)])) {
    const localRevision = local.historiesRevisions[char] ?? local.historiesRevision
    const remoteRevision = remote.historiesRevisions[char] ?? remote.historiesRevision
    if (remoteRevision < localRevision) continue
    const previous = own[char] || emptyChatConversation(), incoming = other[char] || emptyChatConversation()
    if (remoteRevision > localRevision) {
      local.conversations[char] = incoming
      local.histories[char] = cloneChatMessages(incoming.branches.find(branch => branch.id === incoming.activeId)!.messages)
    } else {
      const selected = incoming.selectionRevision > previous.selectionRevision
        || incoming.selectionRevision === previous.selectionRevision && incoming.activeId > previous.activeId ? incoming : previous
      const merged: ChatConversation = { activeId: selected.activeId, selectionRevision: selected.selectionRevision, branches: [] }
      for (const id of new Set([...previous.branches.map(branch => branch.id), ...incoming.branches.map(branch => branch.id)])) {
        const a = previous.branches.find(branch => branch.id === id), b = incoming.branches.find(branch => branch.id === id)
        if (!a || !b) {
          const branch = JSON.parse(JSON.stringify(a || b))
          merged.branches.push(branch)
          if (!a) for (const message of branch.messages) snapshots.set(`${char}::${id}::${chatMessageKey(message)}`, JSON.stringify(message))
          continue
        }
        const live = id === previous.activeId ? local.histories[char] || [] : a.messages
        const branchSnapshots = new Map<string, string>()
        for (const message of live) {
          const key = `${char}::${id}::${chatMessageKey(message)}`
          const baseline = snapshots.get(key)
          if (baseline !== undefined) branchSnapshots.set(chatMessageKey(message), baseline)
        }
        const messages = mergeHistories(live, b.messages, branchSnapshots)
        for (const [key, value] of branchSnapshots) snapshots.set(`${char}::${id}::${key}`, value)
        merged.branches.push({ ...a, messages: cloneChatMessages(messages) })
        if (id === previous.activeId) live.splice(0, live.length, ...messages)
      }
      local.conversations[char] = merged
      if (selected.activeId !== previous.activeId) local.histories[char] = cloneChatMessages(merged.branches.find(branch => branch.id === selected.activeId)!.messages)
    }
    local.historiesRevisions[char] = Math.max(localRevision, remoteRevision)
    local.historiesRevision = Math.max(local.historiesRevision, remoteRevision)
  }
}
export function rememberChatConversations(state: ConversationState, snapshots: Map<string, string>, characters?: string[]) {
  if (!characters) snapshots.clear()
  else for (const key of snapshots.keys()) if (characters.some(char => key.startsWith(`${char}::`))) snapshots.delete(key)
  for (const [char, conversation] of Object.entries(projectChatConversations(state, characters))) for (const branch of conversation.branches) {
    for (const message of branch.messages) snapshots.set(`${char}::${branch.id}::${chatMessageKey(message)}`, JSON.stringify(message))
  }
}
export const chatBranchArchiveKey = (char: string, branchId: string) => branchId === 'main' ? char : `${char}::${branchId}`

/** Standalone archive imports can recreate a selectable story without changing the active one. */
export function registerArchivedChatBranches(state: ConversationState, keys: string[]): boolean {
  let changed = false
  for (const key of keys) {
    const separator = key.indexOf('::'), char = key.slice(0, separator), id = key.slice(separator + 2)
    if (separator < 1 || !Object.hasOwn(state.histories, char) || !id || id.length > 160 || id.includes('::')) continue
    const conversation = state.conversations[char] ||= emptyChatConversation(state.histories[char])
    if (conversation.branches.some(branch => branch.id === id)) continue
    conversation.branches.push({ id, name: `导入剧情 ${conversation.branches.length}`, createdAt: Date.now(), messages: [] })
    changed = true
  }
  return changed
}
