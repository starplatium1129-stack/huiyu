import { onMounted, onUnmounted, watch, type ComputedRef, type Ref } from 'vue'
import type { RouteLocationNormalizedLoaded, Router } from 'vue-router'
import {
  getCompanionCharacter,
  getCompanionCharacterConfig,
} from '@/utils/companionRegistry'
import type { CharacterConfig } from '@/config/characters'
import type { useChatStorage } from '@/composables/chat/useChatStorage'
import type { useVoice } from '@/composables/useVoice'
import type { CharacterStageHandle } from '@/composables/chat/useCharacterStageSync'
import { clearStoredChatContent } from '@/utils/chatReset'
import { confirmAction } from '@/composables/useConfirm'
import { withChatTurn } from '@/utils/chatTurnOwnership'
import { CHAT_TURN_KEY } from '@/utils/storageKeys'
import type { CompanionChatSendOptions } from '@/types/companionDrawing'
import { observeWindowVisibility } from '@/platform/windowVisibility'
import { usePolling } from '@/composables/usePolling'

export function useCharacterRoomLifecycle(options: {
  route: RouteLocationNormalizedLoaded
  router: Router
  storage: ReturnType<typeof useChatStorage>
  voice: ReturnType<typeof useVoice>
  characterStageRef: Ref<CharacterStageHandle | undefined>
  activeChar: Ref<string>
  currentCharacter: ComputedRef<CharacterConfig>
  busy: Ref<boolean>
  resettingChat: Ref<boolean>
  chatMutationBusy: ComputedRef<boolean>
  storyBusy: Ref<boolean>
  chatReady: ComputedRef<boolean>
  chatProvider: Ref<string>
  currentModel: Ref<string>
  useHostConfig: Ref<boolean>
  hostApiModel: Ref<string>
  apiConfigured: ComputedRef<boolean>
  apiModel: Ref<string>
  volume: Ref<number>
  inputText: Ref<string>
  voiceStatusText: Ref<string>
  initialStorage: Promise<void>
  isDisposed: () => boolean
  markDisposed: () => void
  clearErrorTimer: () => void
  setError: (message: string, kind?: string, timeout?: number, code?: string) => void
  setChatStatus: (text: string, kind: string) => void
  sendMessage: (customText?: string, imageUrl?: string, sendOptions?: CompanionChatSendOptions) => Promise<void>
  abortCurrentRequest: (silent?: boolean, cancelImage?: boolean) => boolean
  stopConversation: () => boolean
  cancelStoryAction: () => void
  clearDraftInput: () => void
  resetMemoryState: () => void
  forgetSuperseded: () => void
  updateVoiceCapability: () => void
  refreshVoiceStatus: () => Promise<void>
  refreshChatStatus: () => Promise<void>
  onChatAuxStorage: (event: StorageEvent) => void
  destroyRoomSetup: () => void
  destroyConversation: () => void
}) {
  const {
    route, router, storage, voice, characterStageRef, activeChar, currentCharacter,
    busy, resettingChat, chatMutationBusy, storyBusy, chatReady, chatProvider, currentModel,
    useHostConfig, hostApiModel, apiConfigured, apiModel, volume, inputText, voiceStatusText,
    initialStorage, isDisposed, markDisposed, clearErrorTimer, setError, setChatStatus,
    sendMessage, abortCurrentRequest, stopConversation, cancelStoryAction, clearDraftInput,
    resetMemoryState, forgetSuperseded, updateVoiceCapability, refreshVoiceStatus,
    refreshChatStatus, onChatAuxStorage, destroyRoomSetup, destroyConversation,
  } = options

  let statusVisible = true
  let stopStatusVisibility: (() => void) | undefined
  const statusPolling = usePolling({
    intervalMs: 30_000,
    paused: () => !statusVisible,
    tick: async () => { await Promise.all([busy.value ? undefined : refreshChatStatus(), refreshVoiceStatus()]) },
  })
  let selectionChanged = false
  let inputRevision = 0
  const confirmationController = new AbortController()

  watch(inputText, () => { inputRevision++ }, { flush: 'sync' })
  watch(currentModel, (value) => { if (value) storage.setModel(value) })
  watch(() => route.query.character, (id, _previous, cleanup) => {
    if (typeof id !== 'string') return
    if (getCompanionCharacterConfig(id)) { switchCharacter(id); return }
    let current = true
    cleanup(() => { current = false })
    void import('@/router/companionResources').then(({ loadActiveCompanion }) => loadActiveCompanion(id)).then(() => {
      if (current && !isDisposed()) switchCharacter(id)
    }).catch(() => {})
  })

  function handleSend(customText?: string | Event, imageUrl?: string, accepted?: (value: boolean) => boolean | void, sendOptions: CompanionChatSendOptions = {}) {
    if (isDisposed() || chatMutationBusy.value || storyBusy.value || !storage.canWrite()) { accepted?.(false); return }
    characterStageRef.value?.setUserMessage()
    const text = typeof customText === 'string' ? customText : undefined
    const character = activeChar.value
    let acknowledged = false
    const acknowledge = (value: boolean) => { acknowledged = true; return accepted?.(value) }
    void withChatTurn(async () => {
      if (isDisposed() || chatMutationBusy.value || activeChar.value !== character || busy.value || !storage.canWrite() || (!chatReady.value && sendOptions.action !== 'generate-from-image') || !(text ?? inputText.value).trim()) { acknowledge(false); return }
      if (chatProvider.value === 'muse' && (imageUrl || sendOptions.image) && sendOptions.action !== 'generate-from-image') {
        acknowledge(false)
        setError('Muse 目前只接收文字，请用文字描述图片。', 'info')
        return
      }
      if (acknowledge(true) === false) { setError('未能接收，请检查连接。'); return }
      try { localStorage.setItem(CHAT_TURN_KEY, String(Date.now())) } catch { /* optional playback coordination */ }
      await sendMessage(text, imageUrl, sendOptions)
    }, () => { acknowledge(false); if (!isDisposed()) setError('另一个聊天窗口正在回复，草稿已保留。请等回复结束，或在那个窗口停止。', 'info') })
      .catch(() => { if (!acknowledged) acknowledge(false); if (!isDisposed()) setError('本次对话未能完成，请保留当前内容并重试。') })
  }

  function stopEverything() {
    cancelStoryAction()
    if (stopConversation()) voiceStatusText.value = ''
  }

  function switchCharacter(char: string) {
    const nextCharacter = getCompanionCharacterConfig(char)
    if (!nextCharacter || char === activeChar.value) return
    selectionChanged = true
    cancelStoryAction()
    if (busy.value) abortCurrentRequest(true, false)
    storage.setDraft(activeChar.value, inputText.value)
    voice.stop({ preserveMessageAudio: true, silent: true })
    storage.setActive(char)
    activeChar.value = char
    if (typeof route.query.character === 'string' && route.query.character !== char)
      void router.replace({ query: { ...route.query, character: char } })
    document.documentElement.style.setProperty('--character-accent', nextCharacter.accent)
    inputText.value = storage.draft(char)
    updateVoiceCapability()
    if (nextCharacter.voice || getCompanionCharacter(char)?.catalogId) void refreshVoiceStatus()
    setError('')
  }

  async function clearAllMemory() {
    if (isDisposed() || chatMutationBusy.value || !storage.canWrite()) return
    const confirmed = await confirmAction({
      title: '清空本机聊天内容与个人档案？',
      message: '清除所有当前及退休角色的对话、归档、事实记忆、草稿、个人称呼与备注和本会话语音缓存。保留 API 连接、凭据、外观、音量及行为偏好。已导出的文件和第三方记录不受影响。此操作无法撤销。',
      confirmLabel: '清空聊天内容',
      danger: true,
      signal: confirmationController.signal,
    })
    if (!confirmed || isDisposed() || chatMutationBusy.value) return
    resettingChat.value = true
    cancelStoryAction()
    const inputOwner = { character: activeChar.value, revision: inputRevision }
    if (busy.value) abortCurrentRequest(true)
    voice.stop({ preserveMessageAudio: false, silent: true })
    try {
      const result = await clearStoredChatContent()
      if (isDisposed()) return
      if (activeChar.value === inputOwner.character && inputRevision === inputOwner.revision) clearDraftInput()
      storage.canWrite()
      await storage.load()
      if (isDisposed()) return
      resetMemoryState()
      forgetSuperseded()
      if (result.failed.length) setError(`部分聊天内容未清除（${result.failed.length} 项），请重试清空；已删除内容不会恢复。`, 'warning', 0)
      else setError('本机聊天内容与个人档案已清空；连接和偏好已保留。', 'info', 5000)
    } catch {
      if (!isDisposed()) setError('清空未完成，存储不可写或数据版本不兼容；请排除问题后重试。', 'warning', 0)
    } finally { resettingChat.value = false }
  }

  onMounted(async () => {
    window.addEventListener('storage', onChatAuxStorage)
    await initialStorage
    if (isDisposed()) return
    if (!selectionChanged && !busy.value && !inputText.value) {
      const selected = typeof route.query.character === 'string' ? route.query.character : storage.state.active
      if (getCompanionCharacterConfig(selected)) {
        activeChar.value = selected
        if (storage.state.active !== selected) storage.setActive(selected)
      }
      inputText.value = storage.draft(activeChar.value)
    }
    document.documentElement.style.setProperty('--character-accent', currentCharacter.value.accent)
    if (chatProvider.value === 'api') {
      if (useHostConfig.value) {
        setChatStatus(`站主配置 · ${hostApiModel.value || 'API'}`, 'online')
      } else {
        setChatStatus(
          apiConfigured.value ? `自定义 API · ${apiModel.value}` : '等待配置自定义 API',
          apiConfigured.value ? 'online' : '',
        )
      }
    }
    voice.setVolume(volume.value / 100)
    stopStatusVisibility = observeWindowVisibility(value => { statusVisible = value; statusPolling.sync() })
    statusPolling.start()
  })

  onUnmounted(() => {
    markDisposed()
    confirmationController.abort()
    window.removeEventListener('storage', onChatAuxStorage)
    stopStatusVisibility?.()
    statusPolling.stop()
    destroyRoomSetup()
    clearErrorTimer()
    destroyConversation()
    voice.destroy()
  })

  return {
    handleSend,
    stopEverything,
    switchCharacter,
    clearAllMemory,
  }
}
