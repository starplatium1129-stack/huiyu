import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import { chatApi, type ChatGptStatus } from '@/api/chatApi'
import {
  companionQqApi,
  type QqBotsResponse,
  type QqChannelStatus,
  type QqCharacterId,
  type QqChatCardOption,
  type QqChatProvider,
  type QqOwnerBond,
  type QqVoiceMode,
  type QqVoiceProfile,
  type QqVoiceServiceStatus,
} from '@/api/companionChannelsApi'
import { desktopRuntimeIdentity, onDesktopRuntime } from '@/platform/desktop/runtime'
import { useQqCharacterOptions, useQqServiceStatus, useQqVoiceProfileOptions } from './qqSettingsPresentation'

export function useQqBotSettings(isActive: () => boolean) {
  const workspace = ref(false)
  const loaded = ref(false)
  const bots = shallowRef<QqChannelStatus[]>([])
  const selectedId = ref<string | null>(null)
  const creating = ref(false)
  const confirmDelete = ref(false)

  const cards = shallowRef<QqChatCardOption[]>([])
  const chatGptStatus = shallowRef<ChatGptStatus | null>(null)
  const voiceStatus = shallowRef<QqVoiceServiceStatus | null>(null)

  const botName = ref('')
  const appId = ref('')
  const secret = ref('')
  const character = ref<QqCharacterId>('nene')
  const ownerBond = ref<QqOwnerBond>('default')
  const ownerCallName = ref('')
  const ownerNote = ref('')
  const chatProvider = ref<QqChatProvider>('default')
  const voiceMode = ref<QqVoiceMode>('off')
  const groupVoice = ref(false)
  const voiceProfile = ref<QqVoiceProfile>('auto')
  const enabled = ref(true)
  const drawing = ref(false)
  const groupDrawing = ref(false)
  const groupNaturalReplies = ref(false)
  const groupLabel = ref('')
  const groupMuse = ref(false)
  const privateMuse = ref(false)
  const groupMuseAll = ref(false)
  const museContextLimit = ref(32)
  const museProactive = ref(false)

  const attempted = ref(false)
  const busy = ref(false)
  const feedback = ref('')

  const groupHeading = shallowRef<HTMLElement | null>(null)
  const idField = shallowRef<HTMLInputElement | null>(null)
  const secretField = shallowRef<HTMLInputElement | null>(null)

  const activeBot = computed(() => creating.value ? null : (bots.value.find(bot => bot.id === selectedId.value) ?? null))
  const characterOptions = useQqCharacterOptions(cards, character)
  const voiceProfileOptions = useQqVoiceProfileOptions(voiceStatus)

  const savedSecret = computed(() => Boolean(activeBot.value?.configured && activeBot.value.appId === appId.value))
  const idError = computed(() => attempted.value && !/^\d{1,24}$/.test(appId.value) ? '请输入 QQ 开放平台里的数字 AppID。' : '')
  const secretError = computed(() => attempted.value && (!savedSecret.value || secret.value) && !/^[\x21-\x7E]{8,512}$/.test(secret.value) ? '请检查 AppSecret 是否复制完整。' : '')
  const pairCommand = computed(() => activeBot.value?.pairCode ? `/绑定 ${activeBot.value.pairCode}` : '')
  const groupPairCommand = computed(() => activeBot.value?.groupPairCode ? `/绑定群 ${activeBot.value.groupPairCode}` : '')
  const showMuseDisclosure = computed(() => Boolean(activeBot.value && (activeBot.value.groupMuse || activeBot.value.privateMuse || !bots.value.some(bot => bot.id !== activeBot.value?.id && (bot.groupMuse || bot.privateMuse)))))

  const summaryLabel = computed(() => {
    if (!bots.value.length) return '未配置'
    const online = bots.value.filter(bot => bot.phase === 'online').length
    return `已配置 ${bots.value.length} 个 · ${online} 个在线`
  })

  const serviceStatus = useQqServiceStatus({ chatProvider, chatGptStatus, groupDrawing, voiceStatus })
  const { usesChatGpt } = serviceStatus


  let controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let refreshing = false
  let refreshingChatGpt = false
  let refreshingCards = false
  let refreshingVoice = false
  let mutation = 0
  let identity = ''
  let unsubscribe = () => {}

  function loadBotIntoForm(bot: QqChannelStatus) {
    botName.value = bot.name || ''
    appId.value = bot.appId || ''
    secret.value = ''
    character.value = bot.character
    ownerBond.value = bot.ownerBond ?? 'default'
    ownerCallName.value = bot.ownerCallName || ''
    ownerNote.value = bot.ownerNote || ''
    chatProvider.value = bot.chatProvider ?? 'default'
    voiceMode.value = bot.voiceMode ?? 'off'
    groupVoice.value = bot.groupVoice ?? false
    voiceProfile.value = bot.voiceProfile ?? 'auto'
    enabled.value = bot.enabled
    drawing.value = bot.drawing
    groupDrawing.value = bot.groupDrawing
    groupNaturalReplies.value = bot.groupNaturalReplies ?? false
    groupMuse.value = bot.groupMuse ?? false
    privateMuse.value = bot.privateMuse ?? false
    groupMuseAll.value = bot.groupMuseAll ?? false
    museContextLimit.value = bot.museContextLimit ?? 32
    museProactive.value = bot.museProactive ?? false
    groupLabel.value = ''
    attempted.value = false
    confirmDelete.value = false
  }

  function resetDraftForm() {
    botName.value = ''
    appId.value = ''
    secret.value = ''
    character.value = 'nene'
    ownerBond.value = 'default'
    ownerCallName.value = ''
    ownerNote.value = ''
    chatProvider.value = 'default'
    voiceMode.value = 'off'
    groupVoice.value = false
    voiceProfile.value = 'auto'
    enabled.value = true
    drawing.value = false
    groupDrawing.value = false
    groupNaturalReplies.value = false
    groupMuse.value = false
    privateMuse.value = false
    groupMuseAll.value = false
    museContextLimit.value = 32
    museProactive.value = false
    groupLabel.value = ''
    attempted.value = false
    confirmDelete.value = false
  }

  function selectBot(id: string) {
    const target = bots.value.find(bot => bot.id === id)
    if (!target) return
    creating.value = false
    selectedId.value = target.id
    feedback.value = ''
    loadBotIntoForm(target)
  }

  function startCreate() {
    creating.value = true
    feedback.value = ''
    resetDraftForm()
  }

  function cancelCreate() {
    creating.value = false
    feedback.value = ''
    const target = bots.value.find(bot => bot.id === selectedId.value) ?? bots.value[0]
    if (target) {
      selectedId.value = target.id
      loadBotIntoForm(target)
    }
  }

  function applyResponse(response: QqBotsResponse, restoreFields = false) {
    bots.value = response.bots
    loaded.value = true
    if (response.bot) {
      creating.value = false
      selectedId.value = response.bot.id
      if (restoreFields) loadBotIntoForm(response.bot)
      return
    }
    if (response.bots.length === 0) {
      selectedId.value = null
      creating.value = true
      if (restoreFields) resetDraftForm()
      return
    }
    if (!creating.value) {
      const target = response.bots.find(bot => bot.id === selectedId.value) ?? response.bots[0]
      const changedSelection = selectedId.value !== target.id
      selectedId.value = target.id
      if (restoreFields || changedSelection) loadBotIntoForm(target)
    }
  }

  function schedule() {
    clearTimeout(timer)
    if (isActive() && workspace.value && bots.value.some(bot => bot.enabled)) {
      timer = setTimeout(() => { void refresh() }, 3500)
    }
  }

  async function refreshCards() {
    if (!workspace.value || !isActive() || refreshingCards) return
    refreshingCards = true
    const { signal } = controller
    try {
      const response = await companionQqApi.cards(signal)
      if (!signal.aborted) cards.value = response.cards
    } catch {
      // Card catalog failure keeps built-in characters available.
    } finally {
      if (!signal.aborted) refreshingCards = false
    }
  }

  async function refreshChatGpt() {
    if (!workspace.value || !isActive() || refreshingChatGpt) return
    refreshingChatGpt = true
    const { signal } = controller
    try {
      const value = await chatApi.getChatGptStatus({ signal })
      if (!signal.aborted) chatGptStatus.value = value
    } catch {
      // ChatGPT status check is advisory and must not block QQ settings.
    } finally {
      if (!signal.aborted) refreshingChatGpt = false
    }
  }

  async function refreshVoice() {
    if (!workspace.value || !isActive() || refreshingVoice) return
    refreshingVoice = true
    const { signal } = controller
    try {
      const value = await companionQqApi.voiceStatus(signal)
      if (!signal.aborted) voiceStatus.value = value
    } catch {
      // Voice status check is advisory and must not block QQ settings.
    } finally {
      if (!signal.aborted) refreshingVoice = false
    }
  }

  async function refresh() {
    if (!workspace.value || !isActive() || refreshing || busy.value) { schedule(); return }
    refreshing = true
    const revision = mutation
    const { signal } = controller
    try {
      const value = await companionQqApi.list(signal)
      if (!signal.aborted && !busy.value && revision === mutation) {
        const initial = !loaded.value
        if (initial) feedback.value = ''
        applyResponse(value, initial)
      }
    } catch (error) {
      if (!signal.aborted && !loaded.value) {
        feedback.value = error instanceof Error ? error.message : '无法读取 QQ 机器人设置。'
      }
    } finally {
      if (!signal.aborted) { refreshing = false; schedule() }
    }
  }

  async function change(action: (signal: AbortSignal) => Promise<QqBotsResponse>, restoreFields = false) {
    if (busy.value || !workspace.value) return
    const { signal } = controller
    mutation++
    busy.value = true
    feedback.value = ''
    try {
      const result = await action(signal)
      if (!signal.aborted) {
        applyResponse(result, restoreFields)
      }
    } catch (error) {
      if (!signal.aborted) feedback.value = error instanceof Error ? error.message : '连接设置暂时无法保存。'
    } finally {
      if (!signal.aborted) { busy.value = false; schedule() }
    }
  }

  async function save() {
    attempted.value = true
    if (idError.value || secretError.value) {
      await nextTick()
      const field = idError.value ? idField.value : secretField.value
      const disclosure = field?.closest('details')
      if (disclosure) disclosure.open = true
      field?.focus()
      return
    }
    const payload = {
      name: botName.value,
      appId: appId.value,
      secret: secret.value || undefined,
      character: character.value,
      ownerBond: ownerBond.value,
      ownerCallName: ownerCallName.value,
      ownerNote: ownerNote.value,
      chatProvider: chatProvider.value,
      voiceMode: voiceMode.value,
      groupVoice: groupVoice.value,
      voiceProfile: voiceProfile.value,
      enabled: enabled.value,
      drawing: drawing.value,
      groupDrawing: groupDrawing.value,
      groupNaturalReplies: groupNaturalReplies.value,
      groupMuse: showMuseDisclosure.value ? groupMuse.value : undefined,
      privateMuse: showMuseDisclosure.value ? privateMuse.value : undefined,
      groupMuseAll: showMuseDisclosure.value ? groupMuseAll.value : undefined,
      museContextLimit: showMuseDisclosure.value ? museContextLimit.value : undefined,
      museProactive: showMuseDisclosure.value ? museProactive.value : undefined,
    }
    if (creating.value || !activeBot.value) {
      await change(signal => companionQqApi.create(payload, signal), true)
    } else {
      const targetId = activeBot.value.id
      await change(signal => companionQqApi.update(targetId, payload, signal), true)
    }
    if (usesChatGpt.value) void refreshChatGpt()
    if (voiceMode.value !== 'off') void refreshVoice()
  }

  function removeBot() {
    if (!activeBot.value) return
    const targetId = activeBot.value.id
    confirmDelete.value = false
    void change(signal => companionQqApi.remove(targetId, signal), true)
  }

  function pair() {
    if (!activeBot.value) return
    const targetId = activeBot.value.id
    void change(signal => companionQqApi.pair(targetId, signal))
  }

  function pairGroup() {
    if (!activeBot.value) return
    const targetId = activeBot.value.id
    void change(signal => companionQqApi.pairGroup(targetId, groupLabel.value, signal))
  }

  async function removeGroup(groupId: string) {
    if (!activeBot.value) return
    const targetId = activeBot.value.id
    const previous = document.activeElement
    await change(signal => companionQqApi.removeGroup(targetId, groupId, signal))
    if (!activeBot.value || activeBot.value.groups.some(group => group.id === groupId)) return
    await nextTick()
    if (document.activeElement === document.body || document.activeElement === previous) {
      groupHeading.value?.focus({ preventScroll: true })
    }
  }

  watch(isActive, active => {
    if (active) {
      void refresh()
      void refreshCards()
      void refreshChatGpt()
      void refreshVoice()
    } else {
      clearTimeout(timer)
    }
  })
  watch(usesChatGpt, enabledChatGpt => {
    if (enabledChatGpt) void refreshChatGpt()
  })
  watch(() => voiceMode.value !== 'off', enabledVoice => {
    if (enabledVoice) void refreshVoice()
  })

  onMounted(() => {
    unsubscribe = onDesktopRuntime(runtime => {
      const next = desktopRuntimeIdentity(runtime.bootstrap)
      const available = runtime.connection === 'ready' && Boolean(runtime.bootstrap?.runtime?.workspace)
      if (next === identity && available === workspace.value) return
      controller.abort()
      controller = new AbortController()
      refreshing = false
      refreshingChatGpt = false
      refreshingCards = false
      refreshingVoice = false
      busy.value = false
      loaded.value = false
      bots.value = []
      cards.value = []
      chatGptStatus.value = null
      voiceStatus.value = null
      selectedId.value = null
      creating.value = false
      feedback.value = ''
      resetDraftForm()
      workspace.value = available
      identity = next
      void refresh()
      void refreshCards()
      void refreshChatGpt()
      void refreshVoice()
    })
  })
  onUnmounted(() => { unsubscribe(); controller.abort(); clearTimeout(timer) })

  return {
    ...characterOptions,
    ...serviceStatus,
    workspace, loaded, bots, selectedId, creating, confirmDelete, busy, feedback, activeBot, summaryLabel,
    botName, appId, secret, character, ownerBond, ownerCallName, ownerNote, chatProvider,
    voiceMode, groupVoice, voiceProfile, voiceProfileOptions, enabled, drawing, groupDrawing, groupNaturalReplies, groupLabel,
    groupMuse, privateMuse, groupMuseAll, museContextLimit, museProactive, showMuseDisclosure,
    groupHeading, idField, secretField, savedSecret, idError, secretError, pairCommand, groupPairCommand,
    selectBot, startCreate, cancelCreate, refresh, save, removeBot, pair, pairGroup, removeGroup,
  }
}
