import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import type { ChatMessage } from '@/composables/chat/chatStorageTypes'
import type { useChatStorage } from '@/composables/chat/useChatStorage'
import type { useChatRpSettings } from '@/composables/chat/useChatRpSettings'
import type { useChatSceneState } from '@/composables/chat/useChatSceneState'
import type { useChatProvider } from '@/composables/chat/useChatProvider'

type ChatProviderKind = ReturnType<typeof useChatProvider>['chatProvider']['value']
type ChatSceneStateEntry = ReturnType<ReturnType<typeof useChatSceneState>['getSceneState']>

export async function buildChatExtraPayload(charId: string, activeBranchId: string) {
  const [{ collectActiveLorebookPayload }, { getStorySummary }, { resolvePersonaForCharacter, toChatUserProfile }] = await Promise.all([
    import('@/utils/chatLorebooks'),
    import('@/utils/chatStorySummary'),
    import('@/utils/chatUserPersonas'),
  ])
  const lorebooks = collectActiveLorebookPayload(charId)
  const storySummary = getStorySummary(charId, activeBranchId).text
  const persona = toChatUserProfile(resolvePersonaForCharacter(charId))
  return {
    ...(lorebooks ? { lorebooks } : {}),
    ...(storySummary ? { storySummary } : {}),
    userProfile: persona,
  }
}

export interface UseChatAutoSummaryOptions {
  activeChar: Readonly<Ref<string>>
  branchId: Readonly<Ref<string>>
  chatProvider: Readonly<Ref<ChatProviderKind>>
  busy: Readonly<Ref<boolean>>
  storyBusy: Readonly<Ref<boolean>>
  isLocalHost: Readonly<Ref<boolean>>
  storage: ReturnType<typeof useChatStorage>
  rpSettings: ReturnType<typeof useChatRpSettings>
  currentCharacter: Readonly<Ref<{ name: string }>>
  currentMessages: Readonly<Ref<ChatMessage[]>>
  currentSceneState: Readonly<Ref<ChatSceneStateEntry>>
  useHostConfig: Readonly<Ref<boolean>>
  currentModel: Readonly<Ref<string>>
  apiBaseUrl: Readonly<Ref<string>>
  apiModel: Readonly<Ref<string>>
  apiKey: Readonly<Ref<string>>
  chatGptSelectedModel: Readonly<Ref<string>>
  chatGptClientId: Readonly<Ref<string>>
  userProfile: Readonly<Ref<{ callName?: string }>>
  setError: (message: string, kind?: string, timeout?: number, code?: string) => void
}

/** Owns background rolling story summarization and on-demand scene illustrations. */
export function useChatAutoSummary(options: UseChatAutoSummaryOptions) {
  const {
    activeChar,
    branchId,
    chatProvider,
    busy,
    storyBusy,
    isLocalHost,
    storage,
    rpSettings,
    currentCharacter,
    currentMessages,
    currentSceneState,
    useHostConfig,
    currentModel,
    apiBaseUrl,
    apiModel,
    apiKey,
    chatGptSelectedModel,
    chatGptClientId,
    userProfile,
    setError,
  } = options

  const memorySummaryContext = computed(() => ({
    provider: chatProvider.value,
    model: chatProvider.value === 'chatgpt' ? chatGptSelectedModel.value : useHostConfig.value ? '' : currentModel.value,
    hostConfig: chatProvider.value === 'api' && useHostConfig.value,
    api: chatProvider.value === 'api' && !useHostConfig.value
      ? { baseUrl: apiBaseUrl.value, model: apiModel.value, apiKey: apiKey.value }
      : undefined,
    chatgptClientId: chatProvider.value === 'chatgpt' ? chatGptClientId.value || undefined : undefined,
    userName: userProfile.value.callName || '用户',
    messages: currentMessages.value.map(m => ({ mid: m.mid, role: m.role, content: m.content })),
  }))

  let autoSummarizeAbort: AbortController | null = null
  function cancelAutoSummary() {
    autoSummarizeAbort?.abort()
    autoSummarizeAbort = null
  }
  watch([activeChar, branchId], cancelAutoSummary, { flush: 'sync' })
  onBeforeUnmount(cancelAutoSummary)

  async function maybeAutoSummarize(charId: string, completedBranchId: string) {
    const isCurrent = () => activeChar.value === charId && branchId.value === completedBranchId
    if (autoSummarizeAbort || chatProvider.value === 'muse' || !isCurrent()) return
    const maxMessages = rpSettings.rpState.value.contextBudget.maxMessages
    if (storage.messages(charId).length <= maxMessages) return
    const controller = new AbortController()
    autoSummarizeAbort = controller
    try {
      const { getStorySummary, requestStorySummary, saveStorySummary } = await import('@/utils/chatStorySummary')
      if (controller.signal.aborted || !isCurrent()) return
      const entry = getStorySummary(charId, completedBranchId)
      if (!entry.autoEnabled) return
      const msgs = storage.messages(charId)
      const prevIdx = entry.summarizedThroughMid ? msgs.findIndex(m => m.mid === entry.summarizedThroughMid) : -1
      const keepRecent = Math.min(8, Math.floor(maxMessages / 2))
      const summarizeEnd = msgs.length - keepRecent
      if (summarizeEnd <= prevIdx + 9) return
      const slice = msgs.slice(Math.max(0, prevIdx + 1), summarizeEnd)
      const summary = await requestStorySummary({
        ...memorySummaryContext.value,
        characterName: currentCharacter.value.name,
        existingSummary: entry.text,
        messages: slice.map(m => ({ role: m.role, content: m.content })),
        signal: controller.signal,
      })
      if (controller.signal.aborted || !isCurrent()) return
      saveStorySummary(charId, completedBranchId, {
        text: summary,
        summarizedThroughMid: slice.at(-1)?.mid || entry.summarizedThroughMid,
      })
      setError('已自动滚动更新前情提要。', 'info', 2500)
    } catch {
      /* Silent background task: failures never disrupt active chatting. */
    } finally {
      if (autoSummarizeAbort === controller) autoSummarizeAbort = null
    }
  }

  const illustration = ref<{ branch: string; mid: string; status: string }>()
  const illustratingMid = computed(() => illustration.value?.branch === branchId.value ? illustration.value.mid : '')
  const illustrateStatus = computed(() => {
    const task = illustration.value
    if (!task) return ''
    return task.branch === branchId.value ? task.status : '正在为另一剧情分支绘制插画…'
  })
  let illustrateController: AbortController | null = null
  function cancelIllustration() {
    illustrateController?.abort('user-cancel')
    illustrateController = null
    illustration.value = undefined
  }
  watch(activeChar, cancelIllustration, { flush: 'sync' })
  onBeforeUnmount(cancelIllustration)

  async function illustrateMessage(message: ChatMessage) {
    if (!isLocalHost.value || illustrateController || busy.value || storyBusy.value || storage.writeBlocked.value) return
    const characterId = activeChar.value
    const originBranch = branchId.value
    const characterName = currentCharacter.value.name
    const sceneState = { ...currentSceneState.value }
    const targetMessage = { mid: message.mid, content: message.content }
    const index = currentMessages.value.findIndex(item => item.mid === message.mid)
    const recent = (index >= 0 ? currentMessages.value.slice(Math.max(0, index - 2), index + 1) : [message])
      .map(({ content }) => ({ content }))
    const originIsVisible = () => activeChar.value === characterId && branchId.value === originBranch
    const controller = new AbortController()
    illustrateController = controller
    illustration.value = { branch: originBranch, mid: message.mid, status: '正在构思并绘制剧情插画…' }
    try {
      const { illustrateChatMessage } = await import('@/composables/chat/chatSceneIllustration')
      if (controller.signal.aborted) return
      await illustrateChatMessage({
        characterId,
        branchId: originBranch,
        characterName,
        targetMessage,
        recentMessages: recent,
        sceneState,
        storage,
        signal: controller.signal,
        report: text => { if (illustrateController === controller && illustration.value) illustration.value.status = text },
      })
      if (illustrateController === controller && originIsVisible()) setError('剧情插画已生成并附在消息下方。', 'info', 3500)
    } catch (error) {
      if (illustrateController === controller && !controller.signal.aborted && originIsVisible()) {
        setError(error instanceof Error ? error.message : '剧情插画生成失败，请重试。', 'warning', 6000)
      }
    } finally {
      if (illustrateController === controller) {
        illustrateController = null
        illustration.value = undefined
      }
    }
  }

  return {
    memorySummaryContext,
    maybeAutoSummarize,
    illustratingMid,
    illustrateStatus,
    cancelIllustration,
    illustrateMessage,
  }
}
