import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import {
  DEFAULT_COMPANION_CHARACTER_ID,
  getCompanionCharacterConfig,
} from '@/utils/companionRegistry'
import { useChatConversation } from '@/composables/chat/useChatConversation'
import { useChatStorage, type ChatMessage } from '@/composables/chat/useChatStorage'
import { useChatProvider } from '@/composables/chat/useChatProvider'
import { useVoice } from '@/composables/useVoice'
import { usePolling } from '@/composables/usePolling'
import { controlApi } from '@/api/controlApi'
import { settingsRepository, CHAT_THINKING_SETTING, type ReasoningLevel } from '@/storage/settingsRepository'
import { loadChatUserProfile, saveChatUserProfile, type ChatUserProfile } from '@/utils/chatUserProfile'
import { CHAT_MEMORY_KEY, CHAT_USER_PROFILE_KEY } from '@/utils/storageKeys'
import { isLocalStudioHost } from '@/utils/runtimeEnvironment'
import {
  editChatFact,
  changeStoredChatMemory,
  emptyChatMemoryState,
  isChatFactRemembered,
  loadChatMemoryState,
  recallChatFacts,
  rememberChatFact,
  removeChatFact,
  saveChatMemoryState,
  type ChatMemoryCharacter,
  type ChatMemoryState,
} from '@/utils/chatMemory'
import { characterSettingCards, loadCharacterSettingCards, recallCharacterSetting } from '@/utils/characterSettingMemory'
import { confirmAction } from '@/composables/useConfirm'

interface CharacterStageHandle {
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
  const preparingRoom = ref(false)
  const roomSetupText = ref('一键切到聊天优先：释放受管绘图显存，并启动角色语音服务。')
  const archiveOpen = ref(false)
  const userProfile = ref(loadChatUserProfile())
  const chatMemory = ref(loadChatMemoryState())

  let statusTimer = 0
  let errorTimer = 0
  let disposed = false
  let roomActionRequest: AbortController | null = null

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
  const setupTitle = computed(() => {
    if (preparingRoom.value) return '正在准备角色房间'
    if (chatProvider.value === 'api' && !apiConfigured.value) return '还没有配置自定义 API'
    if (chatProvider.value === 'local' && !ollamaOnline.value) return '本地聊天模型还没有就绪'
    return '角色语音还没有就绪'
  })
  const setupDescription = computed(() => {
    if (preparingRoom.value) return roomSetupText.value
    if (chatProvider.value === 'api' && !apiConfigured.value) {
      return '填写兼容 OpenAI 格式的地址、模型名和密钥后即可对话。'
    }
    if (chatProvider.value === 'api') return 'API 对话已经可用；准备本地语音后可以继续使用逐句配音。'
    return roomSetupText.value
  })
  const hasReplayable = computed(() =>
    currentMessages.value.some(message => message.role === 'assistant' && message.mid && voice.hasAudio(message.mid)),
  )

  function updateVoiceCapability() {
    const voiceId = currentCharacter.value.voice
    if (voice.readyFor(voiceId)) {
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

  function onChatAuxStorage(event: StorageEvent) {
    if (event.key === null || event.key === CHAT_MEMORY_KEY) chatMemory.value = loadChatMemoryState()
    if (event.key === CHAT_USER_PROFILE_KEY) userProfile.value = loadChatUserProfile()
  }

  function updateUserProfile(profile: ChatUserProfile) {
    try {
      userProfile.value = saveChatUserProfile(profile)
      setError('用户档案已保存', 'info', 3000)
    } catch {
      setError('用户档案保存失败，请检查浏览器存储空间。', 'warning')
    }
  }

  function memoryCharacter(value = activeChar.value): ChatMemoryCharacter {
    return getCompanionCharacterConfig(value) ? value : DEFAULT_COMPANION_CHARACTER_ID
  }

  const currentMemories = computed(() => chatMemory.value.byCharacter[memoryCharacter()])

  function persistChatMemory() {
    try {
      saveChatMemoryState(chatMemory.value)
      return true
    } catch {
      setError('长期记忆保存失败，请检查浏览器存储空间。', 'warning')
      return false
    }
  }

  function changeMemory(change: (state: ChatMemoryState) => boolean, message: string) {
    try {
      const next = changeStoredChatMemory(change)
      if (!next) return
      chatMemory.value = next
      setError(message, 'info', 2500)
    } catch { setError('长期记忆保存失败，原有记忆已保留，请检查浏览器存储空间后重试。', 'warning') }
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

  const {
    inputText,
    streamingMid,
    replyAnnouncement,
    abortCurrentRequest,
    sendMessage,
    useStarter,
    onInputChange,
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
    recallMemories: (character, query) => {
      if (!getCompanionCharacterConfig(character)) return []
      if (!characterSettingCards().length) void loadCharacterSettingCards().catch(() => {})
      // 角色设定记忆（2026-08-28 最小闭环）：从 data/characters.json 既有档案派生
      // 的角色设定卡，优先于会话事实注入——LLM 先对齐人设，再结合长期记忆。
      const setting = recallCharacterSetting(characterSettingCards(), memoryCharacter(character), query)
      const facts = recallChatFacts(chatMemory.value, memoryCharacter(character), query)
      return [...setting, ...facts]
    },
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

  function handleSend(customText?: string | Event, imageUrl?: string) {
    characterStageRef.value?.setUserMessage()
    const text = typeof customText === 'string' ? customText : undefined
    void sendMessage(text, imageUrl)
  }

  async function refreshVoiceStatus() {
    await voice.refreshAvailability()
    if (disposed) return
    updateVoiceCapability()
    const voiceId = currentCharacter.value.voice
    if (voice.readyFor(voiceId)) voice.prepare(voiceId, true)
  }

  async function refreshRoomState() {
    if (autoVoice.value) voice.ensureAudioContext()
    await Promise.all([refreshChatStatus(), refreshVoiceStatus()])
  }

  /** 房间准备操作轮询（审计 2026-09-05 P2-05：迁移到 usePolling 底座）。
   *  旧实现 setInterval + 每次先 abort 上一个请求：响应慢于 1.8s 时完成态永远读不到。
   *  底座的 in-flight 去重保证最多一个查询、完成一次再排下一次；代际守卫保证
   *  重入/卸载后旧 tick 的回写被丢弃。返回 false = 轮询结束（底座自动 stop）。 */
  let roomPollOperationId = ''
  let roomPollRequest: AbortController | null = null
  const roomPoll = usePolling({
    intervalMs: 1800,
    tick: async () => {
      const controller = new AbortController()
      roomPollRequest = controller
      try {
        const data = await controlApi.getStatus({ signal: controller.signal })
        if (roomPollRequest !== controller) return false
        const operation = data.operation
        if (!operation || operation.id !== roomPollOperationId) return false
        roomSetupText.value = operation.message || '正在准备本地服务…'
        if (operation.status === 'running') return // void = 继续，完成本次后由底座排下一次
        preparingRoom.value = false
        if (operation.status === 'failed') {
          setError(operation.error || '聊天环境准备失败，请到控制面板查看。')
          roomSetupText.value = '准备失败；可以到控制面板查看服务状态。'
          return false
        }
        await Promise.all([refreshChatStatus(), refreshVoiceStatus()])
        roomSetupText.value = '聊天环境已就绪。'
        return false
      } catch {
        if (controller.signal.aborted) return false
        roomSetupText.value = '仍在后台准备；状态暂时无法读取。'
        return // 瞬时网络抖动：完成本次查询后再安排下一次
      } finally {
        if (roomPollRequest === controller) roomPollRequest = null
      }
    },
  })

  function stopRoomPolling() {
    roomPoll.stop()
    roomPollRequest?.abort()
    roomPollRequest = null
  }

  async function prepareRoom() {
    if (preparingRoom.value) return
    preparingRoom.value = true
    setError('')
    roomSetupText.value = '正在提交聊天优先切换…'
    roomActionRequest?.abort()
    const controller = new AbortController()
    roomActionRequest = controller
    try {
      const data = await controlApi.switchMode('chat', { signal: controller.signal })
      if (roomActionRequest !== controller || controller.signal.aborted) return
      const operationId = String(data.operation?.id || '')
      roomSetupText.value = data.message || '正在准备聊天环境…'
      if (!operationId) {
        preparingRoom.value = false
        await Promise.all([refreshChatStatus(), refreshVoiceStatus()])
        return
      }
      roomPollRequest?.abort()
      roomPollRequest = null
      roomPoll.stop()
      roomPollOperationId = operationId
      roomPoll.start()
    } catch (error) {
      if (controller.signal.aborted) return
      preparingRoom.value = false
      roomSetupText.value = '准备失败；可以到控制面板手动处理。'
      setError(error instanceof Error && error.message ? error.message : '聊天环境准备失败')
    } finally {
      if (roomActionRequest === controller) roomActionRequest = null
    }
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
    const mids = messages.map(message => message.mid).filter(Boolean)
    voice.stop({ preserveMessageAudio: true, silent: true })
    voice.clearMessages(mids)
    storage.clear(targetCharacter)
    setError('已开始新的本地对话。', 'info', 2500)
  }

  async function clearAllMemory() {
    const archiveCounts = storage.archiveCount()
    const hasMemory = Object.values(storage.state.histories).some(items => items.length > 0)
      || Object.values(chatMemory.value.byCharacter).some(items => items.length > 0)
      || Object.values(archiveCounts).some(count => count > 0)
    if (!hasMemory) return
    const confirmed = await confirmAction({
      title: '重置所有对话与聊天数据？',
      message: '将彻底清空宁宁与夏目的全部对话记录、历史归档、长期事实记忆，并重置您的个人称呼档案。此操作无法撤销。',
      confirmLabel: '清空并重置',
      danger: true,
    })
    if (!confirmed) return
    if (busy.value) abortCurrentRequest(true)
    voice.stop({ preserveMessageAudio: false, silent: true })
    storage.clear()
    storage.clearArchive()
    chatMemory.value = emptyChatMemoryState()
    const memorySaved = persistChatMemory()
    userProfile.value = { callName: '', relationship: 'atelier_owner', note: '' }
    settingsRepository.remove({ key: CHAT_USER_PROFILE_KEY })
    if (memorySaved) setError('全部本地聊天数据已重置。', 'info', 3000)
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
    stopRoomPolling()
    roomActionRequest?.abort()
    roomPollRequest = null
    roomActionRequest = null
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
