import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import {
  DEFAULT_COMPANION_CHARACTER_ID,
  getCompanionCharacterConfig,
} from '@/utils/companionRegistry'
import { useChatConversation } from '@/composables/chat/useChatConversation'
import { useChatStorage } from '@/composables/chat/useChatStorage'
import { useChatProvider } from '@/composables/chat/useChatProvider'
import { useVoice } from '@/composables/useVoice'
import { settingsRepository, CHAT_THINKING_SETTING, type ReasoningLevel } from '@/storage/settingsRepository'
import { clearStoredChatContent } from '@/utils/chatReset'
import { isLocalStudioHost } from '@/utils/runtimeEnvironment'
import { loadCharacterSettingCards } from '@/utils/characterSettingMemory'
import { confirmAction } from '@/composables/useConfirm'
import { withChatTurn } from '@/utils/chatTurnOwnership'
import { CHAT_TURN_KEY } from '@/utils/storageKeys'
import { useRoomMemory } from '@/composables/chat/useRoomMemory'
import { useRoomSetup } from '@/composables/chat/useRoomSetup'

interface CharacterStageHandle {
  openSettings?: () => void
  setSpeaking: (value: boolean) => void
  setMouth: (value: number) => void
  setAudioLevel: (level: number, peak?: number) => void
  setEmotion: (emotion: string) => void
  setUserMessage: () => void
  setDesktopVisible?: (visible: boolean) => void
  setDesktopWindowBounds?: (bounds: { x: number; y: number; width: number; height: number }) => void
  setDesktopPerformanceMode?: (onBatteryPower: boolean) => void
  setGlobalPointer?: (screenX: number, screenY: number, bounds: { x: number; y: number; width: number; height: number }) => void
  releasePointerFocus?: () => void
}

export function useCharacterRoomSession() {
  const route = useRoute()
  const chatListRef = ref<HTMLElement>()
  const characterStageRef = ref<CharacterStageHandle>()

  const activeChar = ref(DEFAULT_COMPANION_CHARACTER_ID)
  const busy = ref(false)
  const voiceActive = ref(false)
  const chatError = ref('')
  const chatErrorKind = ref('')
  const voiceStatusText = ref('')
  const voiceCapabilityState = ref('offline')
  const voiceCapabilityText = ref('检查语音…')
  const showVoiceRecovery = ref(false)
  const playingMid = ref('')
  const isSpeaking = ref(false)
  const autoVoice = ref(true)
  const volume = ref(80)
  const archiveOpen = ref(false)

  let statusTimer = 0
  let errorTimer = 0
  let disposed = false

  function setError(message: string, kind = 'error', timeout = 7000) {
    clearTimeout(errorTimer)
    chatError.value = message || ''
    chatErrorKind.value = message ? kind : ''
    if (message && timeout) {
      errorTimer = window.setTimeout(() => setError(''), timeout) as unknown as number
    }
  }

  const storage = useChatStorage((message) => setError(message, 'warning', 9000))
  storage.load()

  const {
    ollamaOnline,
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
  void refreshHostConfig()

  const isLocalHost = computed(() => isLocalStudioHost())

  async function saveToHost() {
    const message = await saveHostConfig()
    setError(message, 'info', 4000)
  }

  async function clearHostConfigAndRefresh() {
    await clearHostConfig()
    setError('站主配置已清除', 'info', 3000)
  }

  autoVoice.value = storage.state.settings.autoVoice
  volume.value = storage.state.settings.volume != null ? storage.state.settings.volume : 80
  activeChar.value = storage.state.active
  const requestedCharacter = typeof route.query.character === 'string' ? route.query.character : ''
  if (getCompanionCharacterConfig(requestedCharacter)) {
    activeChar.value = requestedCharacter
    storage.setActive(requestedCharacter)
  }

  const currentCharacter = computed(() => {
    const config = getCompanionCharacterConfig(activeChar.value)
      || getCompanionCharacterConfig(DEFAULT_COMPANION_CHARACTER_ID)
    if (!config) throw new Error('No companion character presentation is registered')
    return config
  })
  watch(() => route.query.character, id => { if (typeof id === 'string') switchCharacter(id) })

  const voice = useVoice({
    enabled: () => autoVoice.value,
    onStatus: (text) => { voiceStatusText.value = text },
    onError: (message) => setError(message, 'warning'),
    onSpeaking: (speaking, mid) => {
      isSpeaking.value = speaking
      playingMid.value = speaking && mid ? mid : ''
      characterStageRef.value?.setSpeaking(speaking)
    },
    onMouth: (value) => characterStageRef.value?.setMouth(value),
    onAudioLevel: (level, peak) => characterStageRef.value?.setAudioLevel(level, peak),
    onExpression: (emotion) => characterStageRef.value?.setEmotion(emotion),
    onActivity: (active) => { voiceActive.value = active },
  })

  function onVolumeChange() {
    voice.setVolume(volume.value / 100)
    storage.setVolume(volume.value)
  }

  const currentMessages = computed(() => storage.messages(activeChar.value))
  const companionMessages = computed(() => currentMessages.value.slice(-3))
  const webSearchEnabled = computed({
    get: () => storage.state.settings.webSearchEnabled,
    set: value => storage.setWebSearchEnabled(value),
  })

  function updateVoiceCapability() {
    const voiceId = currentCharacter.value.voice
    if (!voiceId) {
      voiceCapabilityText.value = '文字聊天'
      voiceCapabilityState.value = 'text-only'
      showVoiceRecovery.value = false
    } else if (voice.readyFor(voiceId)) {
      voiceCapabilityText.value = 'AI 声线就绪'
      voiceCapabilityState.value = 'ready'
      showVoiceRecovery.value = false
    } else if (voice.availability.value.online) {
      voiceCapabilityText.value = '声线未配置'
      voiceCapabilityState.value = 'warning'
      showVoiceRecovery.value = true
    } else {
      voiceCapabilityText.value = '语音未启动'
      voiceCapabilityState.value = 'offline'
      showVoiceRecovery.value = true
    }
  }

  const {
    preparingRoom,
    roomSetupText,
    setupTitle,
    setupDescription,
    refreshVoiceStatus,
    refreshRoomState,
    prepareRoom,
    destroy: destroyRoomSetup,
  } = useRoomSetup({
    chatProvider,
    apiConfigured,
    ollamaOnline,
    autoVoice,
    currentCharacter,
    voice,
    refreshChatStatus,
    updateVoiceCapability,
    setError,
    isDisposed: () => disposed,
  })

  const hasReplayable = computed(() =>
    currentMessages.value.some(message => message.role === 'assistant' && message.mid && voice.hasAudio(message.mid)),
  )

  function nearBottom() {
    const element = chatListRef.value
    if (!element) return true
    return element.scrollHeight - element.scrollTop - element.clientHeight < 100
  }

  function scrollBottom() {
    nextTick(() => {
      const element = chatListRef.value
      if (element) element.scrollTop = element.scrollHeight
    })
  }

  /** 桌宠本地工具活动指示（悬浮窗/聊天页显示"正在执行 …"） */
  const toolActivity = ref('')
  /** 模型思考过程指示（thinking 模式下收到 reasoning 增量时显示） */
  const thinkingActivity = ref(false)
  /** 本地环境启用本地工具（网关有 security.isDirectLocalRequest 本机安全守卫） */
  const companionTools = ref(true)
  /** 模型推理强度（opencode 风格多档：off/low/medium/high；默认中档） */
  const reasoning = ref<ReasoningLevel>(settingsRepository.get(CHAT_THINKING_SETTING) ?? 'medium')

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
    stopEverything,
    voice,
    clearDraftInput: () => clearDraftInput(),
  })

  const {
    inputText,
    streamingMid,
    replyAnnouncement,
    abortCurrentRequest,
    sendMessage,
    useStarter,
    onInputChange,
    clearDraftInput,
    destroy: destroyConversation,
    stopEverything: stopConversation,
  } = useChatConversation({
    storage,
    voice,
    activeChar,
    currentCharacter,
    busy,
    chatReady,
    chatProvider,
    currentModel,
    apiBaseUrl,
    apiModel,
    apiKey,
    webSearchEnabled,
    useHostConfig,
    companionTools,
    reasoning,
    userProfile,
    recallMemories,
    setBusy,
    onError: setError,
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

  function handleSend(customText?: string | Event, imageUrl?: string, accepted?: (value: boolean) => boolean | void) {
    if (!storage.canWrite()) { accepted?.(false); return }
    characterStageRef.value?.setUserMessage()
    const text = typeof customText === 'string' ? customText : undefined
    const character = activeChar.value
    void withChatTurn(async () => {
      if (activeChar.value !== character || busy.value || !chatReady.value || !(text ?? inputText.value).trim()) { accepted?.(false); return }
      if (accepted?.(true) === false) { setError('跨窗口状态暂不可用，请在完整房间继续聊天。'); return }
      try { localStorage.setItem(CHAT_TURN_KEY, String(Date.now())) } catch { /* optional playback coordination */ }
      await sendMessage(text, imageUrl)
    }, () => { accepted?.(false); setError('另一个聊天窗口正在回复，草稿已保留。请等回复结束，或在那个窗口停止。', 'info') })
  }

  function stopEverything() {
    if (stopConversation()) voiceStatusText.value = ''
  }

  function switchCharacter(char: string) {
    const nextCharacter = getCompanionCharacterConfig(char)
    if (!nextCharacter || char === activeChar.value) return
    if (busy.value) abortCurrentRequest(true)
    storage.setDraft(activeChar.value, inputText.value)
    voice.stop({ preserveMessageAudio: true, silent: true })
    storage.setActive(char)
    activeChar.value = char
    document.documentElement.style.setProperty('--character-accent', nextCharacter.accent)
    inputText.value = storage.draft(char)
    updateVoiceCapability()
    setError('')
  }

  async function clearCharacterConversation() {
    const targetCharacter = activeChar.value
    const messages = storage.messages(targetCharacter)
    if (!messages.length) return
    const confirmed = await confirmAction({
      title: '清空当前对话？',
      message: '将清空当前角色的本地对话记录并开始新对话，此操作无法撤销。',
      confirmLabel: '清空对话',
      danger: true,
    })
    if (!confirmed) return
    if (disposed || activeChar.value !== targetCharacter) return
    if (busy.value) abortCurrentRequest(true)
    if (!storage.clear(targetCharacter)) return setError('清空未完成，原对话已保留；请检查浏览器存储后重试。', 'warning', 0)
    clearDraftInput()
    storage.setDraft(targetCharacter, '')
    voice.stop({ preserveMessageAudio: true, silent: true })
    voice.clearMessages(messages.map(message => message.mid).filter(Boolean))
    setError('已开始新的本地对话。', 'info', 2500)
  }

  async function clearAllMemory() {
    if (!storage.canWrite()) return
    const confirmed = await confirmAction({
      title: '清空本机聊天内容与个人档案？',
      message: '清除所有当前及退休角色的对话、归档、事实记忆、草稿、个人称呼与备注和本会话语音缓存。保留 API 连接、凭据、外观、音量及行为偏好。已导出的文件和第三方记录不受影响。此操作无法撤销。',
      confirmLabel: '清空聊天内容',
      danger: true,
    })
    if (!confirmed) return
    if (busy.value) abortCurrentRequest(true)
    voice.stop({ preserveMessageAudio: false, silent: true })
    try {
      const result = await clearStoredChatContent()
      clearDraftInput()
      storage.canWrite()
      await storage.load()
      resetMemoryState()
      if (result.failed.length) setError(`部分聊天内容未清除（${result.failed.length} 项），请重试清空；已删除内容不会恢复。`, 'warning', 0)
      else setError('本机聊天内容与个人档案已清空；连接和偏好已保留。', 'info', 5000)
    } catch {
      setError('清空未完成，存储不可写或数据版本不兼容；请排除问题后重试。', 'warning', 0)
    }
  }

  function onAutoVoiceChange() {
    storage.setAutoVoice(autoVoice.value)
    if (!autoVoice.value) voice.stop({ preserveMessageAudio: true })
    else {
      voice.ensureAudioContext()
      updateVoiceCapability()
    }
  }

  async function replayLast() {
    const latest = [...currentMessages.value].reverse()
      .find(message => message.role === 'assistant' && message.mid && voice.hasAudio(message.mid))
    if (!latest) {
      setError('本次打开页面后还没有可重播的语音。', 'info', 3500)
      return
    }
    await voice.playMessage(latest.mid)
  }

  watch(currentModel, (value) => { if (value) storage.setModel(value) })

  onMounted(async () => {
    window.addEventListener('storage', onChatAuxStorage)
    document.documentElement.style.setProperty('--character-accent', currentCharacter.value.accent)
    inputText.value = storage.draft(activeChar.value)
    // 预热角色设定卡（约几十 KB，失败不影响聊天：recall 走空设定 + 会话事实）。
    void loadCharacterSettingCards().catch(() => {})
    await refreshChatStatus()
    if (disposed) return
    await refreshVoiceStatus()
    if (disposed) return
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
    statusTimer = window.setInterval(() => {
      if (document.hidden) return
      if (!busy.value) void refreshChatStatus()
      void refreshVoiceStatus()
    }, 30000) as unknown as number
  })

  onUnmounted(() => {
    disposed = true
    window.removeEventListener('storage', onChatAuxStorage)
    clearInterval(statusTimer)
    destroyRoomSetup()
    clearTimeout(errorTimer)
    destroyConversation()
    voice.destroy()
  })

  return {
    chatListRef,
    characterStageRef,
    activeChar,
    busy,
    voiceActive,
    chatError,
    chatErrorKind,
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
    roomSetupText,
    archiveOpen,
    storage,
    ollamaOnline,
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
    currentCharacter,
    currentMessages,
    companionMessages,
    webSearchEnabled,
    setupTitle,
    setupDescription,
    hasReplayable,
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
    onVolumeChange,
    handleSend,
    useStarter,
    onInputChange,
    prepareRoom,
    stopEverything,
    switchCharacter,
    clearCharacterConversation,
    clearAllMemory,
    onAutoVoiceChange,
    replayLast,
    refreshRoomState,
  }
}
