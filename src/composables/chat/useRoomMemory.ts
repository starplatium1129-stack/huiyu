import { computed, ref, type Ref } from 'vue'
import {
  DEFAULT_COMPANION_CHARACTER_ID,
  getCompanionCharacterConfig,
} from '@/utils/companionRegistry'
import {
  editChatFact,
  changeStoredChatMemory,
  isChatFactRemembered,
  loadChatMemoryState,
  recallChatFacts,
  rememberChatFact,
  removeChatFact,
  type ChatMemoryCharacter,
  type ChatMemoryState,
} from '@/utils/chatMemory'
import { characterSettingCards, loadCharacterSettingCards, recallCharacterSetting } from '@/utils/characterSettingMemory'
import { loadChatUserProfile, saveChatUserProfile, type ChatUserProfile } from '@/utils/chatUserProfile'
import { CHAT_MEMORY_KEY, CHAT_USER_PROFILE_KEY, CHAT_TURN_KEY, CHAT_RESET_KEY } from '@/utils/storageKeys'
import type { ChatMessage, useChatStorage } from '@/composables/chat/useChatStorage'

export interface UseRoomMemoryOptions {
  storage: ReturnType<typeof useChatStorage>
  activeChar: Ref<string>
  setError: (message: string, kind?: string, timeout?: number) => void
  stopEverything: () => void
  voice: {
    stop: (options?: { preserveMessageAudio?: boolean; silent?: boolean }) => void
  }
  clearDraftInput: () => void
}

/** Owns character memory, user profile, and memory synchronization across storage events. */
export function useRoomMemory(options: UseRoomMemoryOptions) {
  const { storage, activeChar, setError, stopEverything, voice, clearDraftInput } = options

  const userProfile = ref(loadChatUserProfile())
  const chatMemory = ref(loadChatMemoryState())

  function memoryCharacter(value = activeChar.value): ChatMemoryCharacter {
    return getCompanionCharacterConfig(value) ? value : DEFAULT_COMPANION_CHARACTER_ID
  }

  const currentMemories = computed(() => chatMemory.value.byCharacter[memoryCharacter()])

  function onChatAuxStorage(event: StorageEvent) {
    if (event.key === CHAT_RESET_KEY) {
      stopEverything()
      voice.stop({ preserveMessageAudio: false, silent: true })
      clearDraftInput()
      storage.canWrite()
      // The reset marker precedes deletion; loading here can republish pre-reset drafts.
      chatMemory.value = loadChatMemoryState()
      userProfile.value = loadChatUserProfile()
    }
    if (event.key === CHAT_TURN_KEY) voice.stop({ preserveMessageAudio: true, silent: true })
    if (event.key === null || event.key === CHAT_MEMORY_KEY) chatMemory.value = loadChatMemoryState()
    if (event.key === CHAT_USER_PROFILE_KEY) userProfile.value = loadChatUserProfile()
  }

  function updateUserProfile(profile: ChatUserProfile) {
    if (!storage.canWrite()) { userProfile.value = loadChatUserProfile(); return }
    try {
      userProfile.value = saveChatUserProfile(profile)
      setError('用户档案已保存', 'info', 3000)
    } catch {
      setError('用户档案保存失败，请检查浏览器存储空间。', 'warning')
    }
  }

  function changeMemory(change: (state: ChatMemoryState) => boolean, message: string) {
    try {
      const next = changeStoredChatMemory(change)
      if (!next) return
      chatMemory.value = next
      setError(message, 'info', 2500)
    } catch {
      setError('长期记忆保存失败，原有记忆已保留，请检查浏览器存储空间后重试。', 'warning')
    }
  }

  function rememberMessage(message: ChatMessage) {
    if (message.role !== 'user') return
    changeMemory(state => Boolean(rememberChatFact(state, memoryCharacter(), message.content, message.mid)), '已加入长期记忆')
  }

  function updateMemory(id: string, text: string) {
    changeMemory(state => editChatFact(state, memoryCharacter(), id, text), '长期记忆已更新')
  }

  function deleteMemory(id: string) {
    changeMemory(state => removeChatFact(state, memoryCharacter(), id), '已删除长期记忆')
  }

  function messageRemembered(mid: string) {
    return isChatFactRemembered(chatMemory.value, memoryCharacter(), mid)
  }

  function recallMemories(character: string, query: string) {
    if (!getCompanionCharacterConfig(character)) return []
    if (!characterSettingCards().length) void loadCharacterSettingCards().catch(() => {})
    // 角色设定记忆（2026-08-28 最小闭环）：从 data/characters.json 既有档案派生
    // 的角色设定卡，优先于会话事实注入——LLM 先对齐人设，再结合长期记忆。
    const setting = recallCharacterSetting(characterSettingCards(), memoryCharacter(character), query)
    const facts = recallChatFacts(chatMemory.value, memoryCharacter(character), query)
    return [...setting, ...facts]
  }

  function resetMemoryState() {
    chatMemory.value = loadChatMemoryState()
    userProfile.value = loadChatUserProfile()
  }

  return {
    userProfile,
    chatMemory,
    currentMemories,
    memoryCharacter,
    updateUserProfile,
    rememberMessage,
    updateMemory,
    deleteMemory,
    messageRemembered,
    recallMemories,
    onChatAuxStorage,
    resetMemoryState,
  }
}
