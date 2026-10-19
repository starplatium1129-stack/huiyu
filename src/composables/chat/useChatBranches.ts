import { createMessageId } from '@/config/characters'
import { captureChatConversations, chatBranchArchiveKey, emptyChatConversation } from '@/utils/chatConversationStorage'
import { applyReplyVariant, chatMessageKey, cloneChatMessages, mergeReplyVariants, replySnapshot } from '@/utils/chatMessageStorage'
import type { ChatMessage, ChatState } from './chatStorageTypes'

export function useChatBranches(state: ChatState, canWrite: () => boolean, refresh: () => boolean, save: (merge?: boolean) => boolean | undefined,
  copyArchive: (source: string, target: string) => void) {
  const regenerations = new Map<string, { branch: string; history: ChatMessage[] }>()
  const conversation = (char: string) => state.conversations[char] ||= emptyChatConversation(state.histories[char] || [])
  const branchId = (char = state.active) => conversation(char).activeId
  function branches(char = state.active) {
    return conversation(char).branches.map(({ messages: _messages, ...metadata }) => ({ ...metadata }))
  }
  function snapshot(char: string) {
    return { conversation: captureChatConversations(state)[char], history: state.histories[char] }
  }
  function rollback(char: string, before: ReturnType<typeof snapshot>) {
    state.conversations[char] = before.conversation; state.histories[char] = before.history
  }
  function switchBranch(char: string, id: string): boolean {
    if (!canWrite() || !Object.hasOwn(state.histories, char) || !refresh()) return false
    const current = conversation(char), target = current.branches.find(branch => branch.id === id)
    if (!target) return false
    if (current.activeId === id) return true
    const before = snapshot(char)
    state.conversations[char] = JSON.parse(JSON.stringify(before.conversation))
    const next = conversation(char)
    next.activeId = id; next.selectionRevision = Math.max(current.selectionRevision + 1, Date.now())
    state.histories[char] = cloneChatMessages(target.messages)
    if (save(false)) return true
    rollback(char, before); return false
  }
  function forkBranch(char: string, mid: string): string | null {
    if (!canWrite() || !Object.hasOwn(state.histories, char) || !refresh()) return null
    const history = state.histories[char], index = history.findIndex(message => message.mid === mid || chatMessageKey(message) === mid)
    if (index < 0 || !history[index].content) return null
    const before = snapshot(char), id = `branch-${crypto.randomUUID()}`
    state.conversations[char] = JSON.parse(JSON.stringify(before.conversation))
    const current = conversation(char), parentId = current.activeId
    const name = `剧情分支 ${current.branches.filter(branch => branch.id !== 'main').length + 1}`
    const messages = cloneChatMessages(history.slice(0, index + 1))
    current.branches.push({ id, name, createdAt: Date.now(), parentId, forkMessageId: chatMessageKey(history[index]), messages: cloneChatMessages(messages) })
    current.activeId = id; current.selectionRevision = Math.max(current.selectionRevision + 1, Date.now())
    state.histories[char] = messages
    if (!save(false)) { rollback(char, before); return null }
    copyArchive(chatBranchArchiveKey(char, parentId), chatBranchArchiveKey(char, id))
    return id
  }
  function selectVariant(char: string, mid: string, variantMid: string): boolean {
    if (!canWrite() || !refresh()) return false
    const history = state.histories[char] || [], message = history.at(-1)
    if (!message || message.role !== 'assistant' || (message.mid !== mid && chatMessageKey(message) !== mid)) return false
    const variant = message.variants?.find(item => item.mid === variantMid)
    if (!variant) return message.mid === variantMid
    const previous = replySnapshot(message)
    applyReplyVariant(message, variant)
    if (save(false)) return true
    applyReplyVariant(message, previous); return false
  }
  function prepareRegeneration(char: string, mid: string): ChatMessage | null {
    if (!canWrite()) return null
    const history = state.histories[char] || [], message = history.at(-1)
    if (!message || message.role !== 'assistant' || !message.content || (message.mid !== mid && chatMessageKey(message) !== mid)) return null
    message.replyId ||= message.mid
    message.variants = mergeReplyVariants(message.variants || [], [replySnapshot(message)])
    regenerations.set(`${char}::${message.replyId}`, { branch: branchId(char), history })
    applyReplyVariant(message, { mid: createMessageId(), content: '', stopped: false })
    return message
  }
  function finishRegeneration(char: string, replyId: string, previousMid: string) {
    const key = `${char}::${replyId}`, active = regenerations.get(key)
    regenerations.delete(key)
    if (!active || !canWrite()) return
    const target = active.history.find(message => chatMessageKey(message) === replyId)
    if (!target) return
    if (target.content.trim()) target.variants = mergeReplyVariants(target.variants || [], [replySnapshot(target)])
    else {
      const previous = target.variants?.find(variant => variant.mid === previousMid)
      if (previous) applyReplyVariant(target, previous)
    }
    if (branchId(char) !== active.branch) {
      const branch = conversation(char).branches.find(item => item.id === active.branch)
      if (!branch) return
      branch.messages = cloneChatMessages(active.history)
    }
    save()
  }
  return { branchId, branches, forkBranch, switchBranch, selectVariant, prepareRegeneration, finishRegeneration }
}
