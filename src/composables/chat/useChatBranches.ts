import { createMessageId } from '@/config/characters'
import { captureChatConversations, chatBranchArchiveKey, emptyChatConversation } from '@/utils/chatConversationStorage'
import { applyReplyVariant, chatMessageKey, cloneChatMessages, mergeReplyVariants, replySnapshot } from '@/utils/chatMessageStorage'
import { MAX_CHAT_DRAWINGS, type CompanionChatImage } from '@/types/companionDrawing'
import type { ChatMessage, ChatState } from './chatStorageTypes'

export function useChatBranches(state: ChatState, canWrite: () => boolean, refresh: () => boolean, save: (merge: boolean, char: string) => boolean | undefined,
  copyArchive: (source: string, target: string, forkMessageId: string, followingMessageIds: string[]) => void) {
  const regenerations = new Map<string, { branch: string; history: ChatMessage[] }>()
  const conversation = (char: string) => state.conversations[char] ||= emptyChatConversation(state.histories[char] || [])
  const branchId = (char = state.active) => conversation(char).activeId
  function branches(char = state.active) {
    return conversation(char).branches.map(({ messages: _messages, ...metadata }) => ({ ...metadata }))
  }
  function snapshot(char: string) {
    return {
      conversation: captureChatConversations(state, [char])[char],
      history: state.histories[char],
      historiesRevision: state.historiesRevision,
      charRevision: state.historiesRevisions[char] ?? state.historiesRevision,
    }
  }
  function rollback(char: string, before: ReturnType<typeof snapshot>) {
    state.conversations[char] = before.conversation
    state.histories[char] = before.history
    state.historiesRevision = before.historiesRevision
    state.historiesRevisions[char] = before.charRevision
  }
  function bumpRevision(char: string) {
    const next = Math.max((state.historiesRevisions[char] || 0) + 1, state.historiesRevision + 1, Date.now())
    state.historiesRevision = next
    state.historiesRevisions[char] = next
  }
  function syncActiveBranch(char: string) {
    const current = conversation(char)
    const active = current.branches.find(branch => branch.id === current.activeId)
    if (active) active.messages = cloneChatMessages(state.histories[char] || [])
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
    if (save(false, char)) return true
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
    const messages = cloneChatMessages(history.slice(0, index + 1)), forkMessageId = chatMessageKey(history[index])
    current.branches.push({ id, name, createdAt: Date.now(), parentId, forkMessageId, messages: cloneChatMessages(messages) })
    current.activeId = id; current.selectionRevision = Math.max(current.selectionRevision + 1, Date.now())
    state.histories[char] = messages
    if (!save(false, char)) { rollback(char, before); return null }
    copyArchive(chatBranchArchiveKey(char, parentId), chatBranchArchiveKey(char, id), forkMessageId, history.slice(index + 1).map(chatMessageKey))
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
    if (save(false, char)) return true
    applyReplyVariant(message, previous); return false
  }
  function editMessage(char: string, mid: string, content: string): boolean {
    const trimmed = content.trim()
    if (!trimmed || !canWrite() || !Object.hasOwn(state.histories, char) || !refresh()) return false
    const history = state.histories[char] || []
    const index = history.findIndex(message => message.mid === mid || chatMessageKey(message) === mid)
    if (index < 0) return false
    const before = snapshot(char)
    state.conversations[char] = JSON.parse(JSON.stringify(before.conversation))
    const target = history[index]
    target.content = trimmed
    const activeVariant = target.variants?.find(variant => variant.mid === target.mid)
    if (activeVariant) activeVariant.content = trimmed
    syncActiveBranch(char)
    bumpRevision(char)
    if (save(false, char)) return true
    rollback(char, before); return false
  }
  function deleteMessage(char: string, mid: string): boolean {
    if (!canWrite() || !Object.hasOwn(state.histories, char) || !refresh()) return false
    const history = state.histories[char] || []
    const index = history.findIndex(message => message.mid === mid || chatMessageKey(message) === mid)
    if (index < 0) return false
    const before = snapshot(char)
    state.conversations[char] = JSON.parse(JSON.stringify(before.conversation))
    history.splice(index, 1)
    syncActiveBranch(char)
    bumpRevision(char)
    if (save(false, char)) return true
    rollback(char, before); return false
  }
  function truncateFrom(char: string, mid: string): boolean {
    if (!canWrite() || !Object.hasOwn(state.histories, char) || !refresh()) return false
    const history = state.histories[char] || []
    const index = history.findIndex(message => message.mid === mid || chatMessageKey(message) === mid)
    if (index < 0) return false
    const before = snapshot(char)
    state.conversations[char] = JSON.parse(JSON.stringify(before.conversation))
    history.splice(index)
    syncActiveBranch(char)
    bumpRevision(char)
    if (save(false, char)) return true
    rollback(char, before); return false
  }
  function attachMessageImage(char: string, mid: string, image: CompanionChatImage): boolean {
    if (!canWrite() || !Object.hasOwn(state.histories, char) || !refresh()) return false
    const history = state.histories[char] || []
    const target = history.find(message => message.mid === mid || chatMessageKey(message) === mid)
    if (!target) return false
    const before = snapshot(char)
    state.conversations[char] = JSON.parse(JSON.stringify(before.conversation))
    const existing = target.images || []
    if (!existing.some(item => item.path === image.path || (image.imageId && item.imageId === image.imageId))) {
      target.images = [...existing, { ...image }].slice(-MAX_CHAT_DRAWINGS)
      const activeVariant = target.variants?.find(variant => variant.mid === target.mid)
      if (activeVariant) activeVariant.images = [...target.images]
      syncActiveBranch(char)
      bumpRevision(char)
    }
    if (save(false, char)) return true
    rollback(char, before); return false
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
  function prepareContinue(char: string, mid: string): { message: ChatMessage; prefix: string; previousMid: string; replyId: string } | null {
    if (!canWrite()) return null
    const history = state.histories[char] || [], message = history.at(-1)
    if (!message || message.role !== 'assistant' || !message.content.trim() || (message.mid !== mid && chatMessageKey(message) !== mid)) return null
    const previousMid = message.mid
    const prefix = message.content
    message.replyId ||= message.mid
    message.variants = mergeReplyVariants(message.variants || [], [replySnapshot(message)])
    regenerations.set(`${char}::${message.replyId}`, { branch: branchId(char), history })
    const nextMid = createMessageId()
    applyReplyVariant(message, { mid: nextMid, content: prefix, stopped: false })
    return { message, prefix, previousMid, replyId: message.replyId }
  }
  function finishRegeneration(char: string, replyId: string, previousMid: string, continuePrefix?: string) {
    const key = `${char}::${replyId}`, active = regenerations.get(key)
    regenerations.delete(key)
    if (!active || !canWrite()) return
    const target = active.history.find(message => chatMessageKey(message) === replyId)
    if (!target) return
    const unchangedContinue = continuePrefix !== undefined && target.content.trim() === continuePrefix.trim()
    if (target.content.trim() && !unchangedContinue) {
      target.variants = mergeReplyVariants(target.variants || [], [replySnapshot(target)])
    } else {
      const previous = target.variants?.find(variant => variant.mid === previousMid)
      if (previous) applyReplyVariant(target, previous)
    }
    if (branchId(char) !== active.branch) {
      const branch = conversation(char).branches.find(item => item.id === active.branch)
      if (!branch) return
      branch.messages = cloneChatMessages(active.history)
    }
    save(true, char)
  }
  return {
    branchId, branches, forkBranch, switchBranch, selectVariant,
    editMessage, deleteMessage, truncateFrom, attachMessageImage,
    prepareRegeneration, prepareContinue, finishRegeneration,
  }
}
