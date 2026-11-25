import { computed, nextTick, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  DEFAULT_COMPANION_CHARACTER_ID,
  getCompanionCharacterConfig,
  renderChatGreeting,
} from '@/utils/companionRegistry'
import { useChatConversation } from '@/composables/chat/useChatConversation'
import { useCompanionToolPermissions } from '@/composables/chat/useCompanionToolPermissions'
import { useChatStorage } from '@/composables/chat/useChatStorage'
import { useChatProvider } from '@/composables/chat/useChatProvider'
import { settingsRepository, CHAT_THINKING_SETTING, type ReasoningLevel } from '@/storage/settingsRepository'
import { isLocalStudioHost } from '@/utils/runtimeEnvironment'
import { useRoomMemory } from '@/composables/chat/useRoomMemory'
import { useRoomSetup } from '@/composables/chat/useRoomSetup'
import { useChatStoryActions } from '@/composables/chat/useChatStoryActions'
import { useChatConversationClear } from '@/composables/chat/useChatConversationClear'
import { screenWatchConnection } from '@/api/companionScreenWatchApi'
import { readChatPreferences } from '@/storage/chatPreferences'
import { useCharacterStageSync } from '@/composables/chat/useCharacterStageSync'
import { useCharacterRoomLifecycle } from '@/composables/chat/useCharacterRoomLifecycle'

export function useCharacterRoomSession(
  reading?: { latest: () => void; nearBottom: () => boolean },
  presentation?: { character: string; startConversation: Promise<void> },
) {
  const route = useRoute()
  const router = useRouter()
  const chatListRef = ref<HTMLElement>()

  const activeChar = ref(DEFAULT_COMPANION_CHARACTER_ID)
  const busy = ref(false)
  const resettingChat = ref(false)
  const chatError = ref('')
  const chatErrorKind = ref('')
  const chatErrorCode = ref('')

  let errorTimer = 0
  let disposed = false

  function setError(message: string, kind = 'error', timeout = 7000, code = '') {
    clearTimeout(errorTimer)
    chatError.value = message || ''
    chatErrorKind.value = message ? kind : ''
    chatErrorCode.value = message ? code : ''
    if (message && timeout) {
      errorTimer = window.setTimeout(() => setError(''), timeout) as unknown as number
    }
  }

  const storage = useChatStorage((message) => setError(message, 'warning', 9000))
  if (presentation) {
    try {
      const preferences = readChatPreferences()
      if (preferences) Object.assign(storage.state.settings, {
        autoVoice: preferences.autoVoice,
        live2dOutfits: { ...storage.state.settings.live2dOutfits, ...preferences.live2dOutfits },
      })
    } catch { /* The regular chat admission reports corrupted preferences. */ }
    if (getCompanionCharacterConfig(presentation.character)) storage.state.active = presentation.character
  }
  const conversationStarted = ref(!presentation)
  const initialStorage = presentation ? presentation.startConversation.then(async () => {
    if (disposed) return
    await storage.load()
    if (!disposed) conversationStarted.value = true
  }) : storage.load()

  const {
    ollamaOnline, localStatusText, checkingChatStatus,
    museStatus, museStatusText, checkingMuse, refreshMuseStatus,
    chatGpt,
    models,
    currentModel,
    chatProvider,
    apiBaseUrl,
    apiModel,
    apiKey,
    apiVendor,
    apiSettingsOpen,
    apiConfigHint,
    chatStatusText,
    statusKind,
    hostApiConfigured,
    hostApiModel,
    hostApiBaseUrl,
    useHostConfig,
    apiConfigured,
    chatReady: providerReady,
    refreshChatStatus,
    refreshHostConfig,
    saveHostConfig,
    clearHostConfig,
    setChatProvider,
    saveApiSettings,
    clearApiCredential,
    setChatStatus,
    setBusy,
  } = useChatProvider({ storage, isBusy: busy })
  const chatReady = computed(() => conversationStarted.value && providerReady.value)
  watch([chatProvider, chatGpt.activeClientId, chatGpt.usagePaused], ([provider, clientId, paused], [, previousClientId, wasPaused]) => {
    if (chatErrorCode.value === 'CHATGPT_USAGE_LIMIT'
      && (provider !== 'chatgpt' || clientId !== previousClientId || (wasPaused && !paused))) setError('')
  })
  if (presentation) void initialStorage.then(() => { if (!disposed) return refreshHostConfig() })
  else void refreshHostConfig()

  const isLocalHost = computed(() => isLocalStudioHost())
  const screenWatchTarget = computed(() => isLocalHost.value && chatProvider.value === 'api' && apiConfigured.value && !useHostConfig.value
    ? screenWatchConnection(apiBaseUrl.value, apiModel.value, apiKey.value) : null)

  async function saveToHost() {
    const message = await saveHostConfig()
    setError(message, 'info', 4000)
  }

  async function clearHostConfigAndRefresh() {
    const cleared = await clearHostConfig()
    setError(cleared ? '站主配置已清除' : '站主配置清除尚未确认，请检查连接后重试；请勿视为已停止托管。', cleared ? 'info' : 'error', 4000)
  }

  activeChar.value = storage.state.active
  const requestedCharacter = typeof route.query.character === 'string' ? route.query.character : ''
  if (getCompanionCharacterConfig(requestedCharacter)) {
    activeChar.value = requestedCharacter
    storage.setActive(requestedCharacter)
  }

  const {
    characterStageRef,
    voiceActive,
    voiceStatusText,
    playingMid,
    isSpeaking,
    autoVoice,
    volume,
    voice,
    currentCharacter,
    onVolumeChange,
  } = useCharacterStageSync({ activeChar, storage, setError })

  const currentMessages = computed(() => storage.messages(activeChar.value))
  const companionMessages = computed(() => currentMessages.value.slice(-3))
  const webSearchEnabled = computed({
    get: () => storage.state.settings.webSearchEnabled,
    set: value => storage.setWebSearchEnabled(value),
  })

  const {
    voiceCapabilityState, voiceCapabilityText, showVoiceRecovery, updateVoiceCapability,
    preparingRoom,
    setupTitle,
    setupDescription,
    refreshVoiceStatus,
    refreshRoomState,
    prepareRoom,
    destroy: destroyRoomSetup,
  } = useRoomSetup({
    chatProvider,
    chatReady,
    apiConfigured,
    ollamaOnline,
    autoVoice,
    currentCharacter,
    voice,
    refreshChatStatus,
    setError,
    isDisposed: () => disposed,
  })

  function nearBottom() {
    if (reading) return reading.nearBottom()
    const element = chatListRef.value
    return !element || element.scrollHeight - element.scrollTop - element.clientHeight < 100
  }

  function scrollBottom() {
    nextTick(() => {
      if (reading) { reading.latest(); return }
      if (chatListRef.value) chatListRef.value.scrollTop = chatListRef.value.scrollHeight
    })
  }

  /** 桌宠本地工具活动指示（悬浮窗/聊天页显示"正在执行 …"） */
  const toolActivity = ref('')
  /** 模型思考过程指示（thinking 模式下收到 reasoning 增量时显示） */
  const thinkingActivity = ref(false)
  /** 本地环境启用本地工具（网关有 security.isDirectLocalRequest 本机安全守卫） */
  const { companionTools } = useCompanionToolPermissions()
  /** 模型推理强度（opencode 风格多档：off/low/medium/high；默认关闭，以兼容房间工具） */
  const reasoning = ref<ReasoningLevel>(settingsRepository.get(CHAT_THINKING_SETTING) ?? 'off')

  function onReasoningChange(level: 'off' | 'low' | 'medium' | 'high') {
    reasoning.value = level
    settingsRepository.set(CHAT_THINKING_SETTING, level)
  }

  const {
    userProfile,
    currentMemories,
    updateUserProfile,
    rememberMessage,
    updateMemory,
    deleteMemory,
    messageRemembered,
    recallMemories,
    onChatAuxStorage,
    resetMemoryState,
  } = useRoomMemory({
    storage,
    activeChar,
    setError,
    stopEverything: () => stopEverything(),
    voice,
    clearDraftInput: () => clearDraftInput(),
  })
  const chatCharacter = computed(() => renderChatGreeting(currentCharacter.value, userProfile.value.callName))

  const {
    inputText,
    streamingMid,
    replyAnnouncement,
    abortCurrentRequest,
    sendMessage,
    regenerateMessage,
    useStarter,
    onInputChange,
    clearDraftInput,
    destroy: destroyConversation,
    stopEverything: stopConversation,
  } = useChatConversation({
    storage,
    voice,
    activeChar,
    currentCharacter: chatCharacter,
    busy,
    chatReady,
    chatProvider,
    currentModel,
    chatgptModel: chatGpt.selectedModel,
    chatgptClientId: chatGpt.activeClientId,
    apiBaseUrl,
    apiModel,
    apiKey,
    webSearchEnabled,
    hostApiBaseUrl,
    hostApiConfigured,
    hostApiModel,
    useHostConfig,
    companionTools,
    reasoning,
    userProfile,
    recallMemories,
    setBusy,
    onError: setError,
    onChatGptStatusChanged: chatGpt.refreshAfterRequest,
    onStreamEmotion: (emotion) => {
      if (autoVoice.value) return
      characterStageRef.value?.setEmotion(emotion)
    },
    onToolActivity: (activity) => {
      toolActivity.value = activity ?? ''
    },
    onThinking: (thinking) => {
      thinkingActivity.value = thinking !== null
    },
    nearBottom,
    scrollBottom,
  })

  const { branchId, storyBranches, storyBusy, handleStoryAction, cancelStoryAction, canRegenerateMessage } = useChatStoryActions({
    storage, activeChar, busy: computed(() => busy.value || clearBusy.value || resettingChat.value), chatReady, regenerateMessage,
    stopVoice: () => voice.stop({ preserveMessageAudio: true, silent: true }), notice: setError, scrollBottom,
  })

  const { clearBusy, clearLabel, clearCharacterConversation, forgetSuperseded } = useChatConversationClear({
    storage, activeChar, isBusy: () => busy.value || storyBusy.value || resettingChat.value, clearDraftInput, notice: setError,
    clearAudio: mids => { voice.stop({ preserveMessageAudio: true, silent: true }); voice.clearMessages(mids) },
  })

  const chatMutationBusy = computed(() => clearBusy.value || resettingChat.value)

  const { handleSend, stopEverything, switchCharacter, clearAllMemory } = useCharacterRoomLifecycle({
    route, router, storage, voice, characterStageRef, activeChar, currentCharacter,
    busy, resettingChat, chatMutationBusy, storyBusy, chatReady, chatProvider, currentModel,
    useHostConfig, hostApiModel, apiConfigured, apiModel, volume, inputText, voiceStatusText,
    initialStorage,
    isDisposed: () => disposed,
    markDisposed: () => { disposed = true },
    clearErrorTimer: () => clearTimeout(errorTimer),
    setError, setChatStatus, sendMessage, abortCurrentRequest, stopConversation,
    cancelStoryAction, clearDraftInput, resetMemoryState, forgetSuperseded,
    updateVoiceCapability, refreshVoiceStatus, refreshChatStatus, onChatAuxStorage,
    destroyRoomSetup, destroyConversation,
  })

  function onAutoVoiceChange() {
    storage.setAutoVoice(autoVoice.value)
    if (!autoVoice.value) voice.stop({ preserveMessageAudio: true })
    else {
      voice.ensureAudioContext()
      updateVoiceCapability()
    }
  }

  return {
    chatListRef,
    characterStageRef,
    activeChar,
    busy,
    voiceActive,
    screenWatchTarget,
    chatError,
    chatErrorKind,
    chatErrorCode,
    toolActivity,
    thinkingActivity,
    reasoning,
    onReasoningChange,
    userProfile,
    updateUserProfile,
    currentMemories,
    rememberMessage,
    updateMemory,
    deleteMemory,
    messageRemembered,
    voiceStatusText,
    voiceCapabilityState,
    voiceCapabilityText,
    showVoiceRecovery,
    playingMid,
    isSpeaking,
    autoVoice,
    volume,
    preparingRoom,
    storage,
    branchId, storyBranches, storyBusy, handleStoryAction, canRegenerateMessage,
    ollamaOnline, localStatusText, checkingChatStatus,
    museStatus, museStatusText, checkingMuse, refreshMuseStatus,
    chatGpt,
    models,
    currentModel,
    chatProvider,
    apiBaseUrl,
    apiModel,
    apiKey,
    apiVendor,
    apiSettingsOpen,
    apiConfigHint,
    chatStatusText,
    statusKind,
    hostApiConfigured,
    hostApiModel,
    hostApiBaseUrl,
    useHostConfig,
    apiConfigured,
    chatReady,
    isLocalHost,
    currentCharacter: chatCharacter,
    currentMessages,
    companionMessages,
    webSearchEnabled, companionTools,
    setupTitle,
    setupDescription,
    inputText,
    streamingMid,
    replyAnnouncement,
    voice,
    setError,
    saveToHost,
    clearHostConfigAndRefresh,
    setChatProvider,
    saveApiSettings,
    clearApiCredential,
    refreshChatStatus,
    onVolumeChange,
    handleSend,
    useStarter,
    onInputChange,
    prepareRoom,
    stopEverything,
    switchCharacter,
    clearCharacterConversation, clearBusy, clearLabel, chatMutationBusy,
    clearAllMemory,
    onAutoVoiceChange,
    refreshRoomState,
  }
}
