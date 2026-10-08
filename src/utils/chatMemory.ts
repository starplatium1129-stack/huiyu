import { profileLocalStorage as localStorage } from '../platform/web/profileStorage.ts'
import { assertStoredChatVersion } from '../storage/chatVersionStorage'
import { CHAT_MEMORY_KEY } from './storageKeys.ts'
import { chatResetRevision } from './chatReset.ts'
import {
  emptyChatMemoryState as emptyState, normalizeChatMemoryState as normalizeState,
  mergeChatMemoryStates as mergeStates, type ChatMemoryState,
} from './chatMemoryCore'
export type { ChatMemoryCharacter, ChatMemoryItem, ChatMemoryState } from './chatMemoryCore'
export { rememberChatFact, editChatFact, removeChatFact, isChatFactRemembered, recallChatFacts } from './chatMemoryCore'

const resetStamp = Symbol('chatReset')
function stamp(state: ChatMemoryState): ChatMemoryState {
  if (typeof globalThis.localStorage !== 'undefined') Object.defineProperty(state, resetStamp, { value: chatResetRevision() })
  return state
}
export function emptyChatMemoryState(): ChatMemoryState { return stamp(emptyState()) }
export function normalizeChatMemoryState(value: unknown): ChatMemoryState { return stamp(normalizeState(value)) }
export function mergeChatMemoryStates(current: ChatMemoryState, incoming: ChatMemoryState): ChatMemoryState {
  return stamp(mergeStates(current, incoming))
}

export function loadChatMemoryState(): ChatMemoryState {
  try {
    return normalizeChatMemoryState(JSON.parse(localStorage.getItem(CHAT_MEMORY_KEY) || 'null'))
  } catch {
    return emptyChatMemoryState()
  }
}

export function saveChatMemoryState(state: ChatMemoryState): void {
  const revision = Reflect.get(state, resetStamp)
  if (revision !== undefined && revision !== chatResetRevision()) throw new Error('聊天内容已清空，旧记忆修改已停止。')
  assertStoredChatVersion(CHAT_MEMORY_KEY, 1)
  localStorage.setItem(CHAT_MEMORY_KEY, JSON.stringify(normalizeChatMemoryState(state)))
}

/** Re-read persisted state before editing; a failed write never changes the displayed snapshot. */
export function changeStoredChatMemory(change: (state: ChatMemoryState) => boolean): ChatMemoryState | null {
  const state = normalizeChatMemoryState(JSON.parse(localStorage.getItem(CHAT_MEMORY_KEY) || 'null'))
  if (!change(state)) return null
  const normalized = normalizeChatMemoryState(state)
  saveChatMemoryState(normalized)
  return normalized
}
