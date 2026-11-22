import { computed, getCurrentScope, onScopeDispose, ref } from 'vue'
import { chatApi, type ChatGptModel, type ChatGptStatus } from '@/api/chatApi'
import { ApiClientError } from '@/api/client'
import { isLocalStudioHost } from '@/utils/runtimeEnvironment'

export const CHATGPT_USAGE_SETTINGS_URL = 'https://chatgpt.com/settings/usage'
const SYNC_CHANNEL = 'huiyu-chatgpt-auth'

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiClientError) {
    if (error.code === 'LOCAL_ONLY') return 'ChatGPT 订阅额度仅支持在运行绘遇的本机使用。'
    if (error.kind === 'timeout') return '连接 OpenAI 超时，请检查网络或代理后重试。'
    if (error.kind === 'network') return '无法连接绘遇后端或 OpenAI，请检查网络和代理设置。'
    if (error.message) return error.message
  }
  return error instanceof Error && error.message ? error.message : fallback
}

export function useChatGptAuth(onStatusChange?: () => void) {
  const status = ref<ChatGptStatus | null>(null)
  const models = ref<ChatGptModel[]>([])
  const loadingStatus = ref(false)
  const loadingModels = ref(false)
  const acting = ref(false)
  const errorText = ref('')
  const noticeText = ref('')
  const welcomeOpen = ref(false)
  const modelsLoaded = ref(false)

  let disposed = false
  let pollTimer = 0
  let statusRevision = 0
  let queuedRefresh = false
  let welcomeDismissed = false
  const controller = new AbortController()
  let modelsController: AbortController | null = null
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(SYNC_CHANNEL) : null

  function broadcastChange() {
    try { channel?.postMessage({ type: 'changed', ts: Date.now() }) } catch { /* optional sync */ }
  }

  function stopPolling() {
    clearTimeout(pollTimer)
    pollTimer = 0
  }

  const activeAccount = computed(() => status.value?.accounts.find(account => account.active) ?? null)
  const activeClientId = computed(() => status.value?.activeClientId || '')
  const signedIn = computed(() => Boolean(status.value?.signedIn))
  const planEnabled = computed(() => Boolean(status.value?.planEnabled))
  const usagePaused = computed(() => Boolean(status.value?.usagePaused))
  const authPending = computed(() => status.value?.authFlow.status === 'pending')
  const canRetryRegistration = computed(() => Boolean(status.value?.authFlow.retryRegistration))
  const selectedModel = computed(() => status.value?.selectedModel || '')
  const selectedModelName = computed(() => status.value?.selectedModelName || status.value?.selectedModel || '')
  const ready = computed(() => isLocalStudioHost() && planEnabled.value && !usagePaused.value
    && models.value.some(model => model.slug === selectedModel.value))

  const statusText = computed(() => {
    if (!isLocalStudioHost()) return 'ChatGPT 订阅额度仅支持在本机使用。'
    if (!status.value) return loadingStatus.value ? '正在检查 ChatGPT 登录状态…' : '尚未连接 ChatGPT 订阅。'
    if (authPending.value) return '正在等待浏览器完成 ChatGPT 登录与授权…'
    if (!signedIn.value) return '请在聊天设置中登录 ChatGPT。'
    if (!planEnabled.value) return '已登录 ChatGPT 账号，但尚未开启订阅额度授权。'
    if (usagePaused.value) return 'ChatGPT 订阅额度已达上限，发送已暂停。'
    if (loadingModels.value) return '正在获取 ChatGPT 可用模型…'
    if (!modelsLoaded.value) return '请在聊天设置中获取 ChatGPT 可用模型。'
    if (!selectedModel.value) return '当前 ChatGPT 账号没有可用模型。'
    return `ChatGPT 订阅 · ${selectedModelName.value}`
  })

  function schedulePoll() {
    stopPolling()
    if (disposed || !authPending.value) return
    pollTimer = window.setTimeout(() => {
      void refreshStatus(true)
    }, 1200)
  }

  function clearModels() {
    modelsController?.abort()
    modelsController = null
    loadingModels.value = false
    modelsLoaded.value = false
    models.value = []
  }

  function applyStatus(next: ChatGptStatus) {
    const previous = status.value
    const previousFlow = previous?.authFlow
    const authChanged = previousFlow?.status !== next.authFlow.status || previousFlow?.startedAt !== next.authFlow.startedAt
    const justCompleted = next.authFlow.status === 'completed' && authChanged
    if (previous?.activeClientId !== next.activeClientId || !next.planEnabled || justCompleted) clearModels()

    statusRevision++
    status.value = next
    schedulePoll()
    if (next.authFlow.status === 'error' && next.authFlow.error && authChanged) {
      errorText.value = next.authFlow.error
      noticeText.value = ''
    } else if (justCompleted && previousFlow?.status === 'pending') {
      errorText.value = ''
      noticeText.value = next.planEnabled ? '已连接 ChatGPT 订阅额度。' : '已登录 ChatGPT 账号，订阅额度权限待开启。'
      broadcastChange()
    }
    welcomeOpen.value = next.planEnabled && !next.welcomeConfirmed && !welcomeDismissed
    onStatusChange?.()
  }

  async function refreshStatus(loadModelsIfEmpty = false) {
    if (disposed || !isLocalStudioHost()) return
    if (loadingStatus.value) {
      queuedRefresh ||= loadModelsIfEmpty
      return
    }
    const revision = statusRevision
    loadingStatus.value = true
    try {
      const next = await chatApi.getChatGptStatus({ signal: controller.signal })
      if (disposed || revision !== statusRevision) return
      applyStatus(next)
      if (loadModelsIfEmpty && next.planEnabled && !modelsLoaded.value && !loadingModels.value) {
        void refreshModels()
      }
    } catch {
      if (!disposed) {
        schedulePoll()
        onStatusChange?.()
      }
    } finally {
      loadingStatus.value = false
      if (queuedRefresh) {
        queuedRefresh = false
        void refreshStatus(true)
      }
    }
  }

  async function refreshModels() {
    const clientId = activeClientId.value
    const modelBeforeFetch = selectedModel.value
    if (disposed || !clientId || !planEnabled.value || loadingModels.value) return
    const current = new AbortController()
    modelsController = current
    loadingModels.value = true
    errorText.value = ''
    try {
      const result = await chatApi.getChatGptModels({ signal: current.signal })
      if (disposed || modelsController !== current || activeClientId.value !== clientId) return
      if (result.clientId !== clientId) {
        void refreshStatus(true)
        return
      }
      models.value = result.models
      modelsLoaded.value = true
      if (status.value && status.value.selectedModel === modelBeforeFetch
        && (status.value.selectedModel !== result.selectedModel || status.value.selectedModelName !== result.selectedModelName)) {
        statusRevision++
        status.value = {
          ...status.value,
          selectedModel: result.selectedModel,
          selectedModelName: result.selectedModelName,
          accounts: status.value.accounts.map(account => account.active
            ? { ...account, selectedModel: result.selectedModel, selectedModelName: result.selectedModelName }
            : account),
        }
        broadcastChange()
      }
      if (!result.models.length) {
        noticeText.value = '当前 ChatGPT 账号没有返回可选模型列表，请稍后重试。'
      }
      onStatusChange?.()
    } catch (error) {
      if (disposed || modelsController !== current || current.signal.aborted) return
      errorText.value = errorMessage(error, '无法获取 ChatGPT 可用模型列表。')
      if (error instanceof ApiClientError && ['CHATGPT_REAUTH_REQUIRED', 'CHATGPT_PLAN_NOT_ENABLED', 'CHATGPT_SELECTION_CHANGED', 'CHATGPT_USAGE_LIMIT'].includes(error.code ?? '')) {
        broadcastChange()
        void refreshStatus()
      }
    } finally {
      if (modelsController === current) {
        modelsController = null
        loadingModels.value = false
      }
    }
  }

  async function startAuth(mode: 'new' | 'retry' | 'reauth' | 'consent', clientId?: string) {
    if (disposed || !isLocalStudioHost() || acting.value || authPending.value) return
    acting.value = true
    errorText.value = ''
    noticeText.value = ''
    try {
      const next = await chatApi.startChatGptAuth({ mode, clientId }, { signal: controller.signal })
      if (disposed) return
      applyStatus(next)
      broadcastChange()
    } catch (error) {
      if (!disposed) {
        errorText.value = errorMessage(error, '无法启动 ChatGPT 登录流程。')
        void refreshStatus(true)
      }
    } finally {
      acting.value = false
    }
  }

  async function cancelAuth() {
    if (disposed || !authPending.value || acting.value) return
    acting.value = true
    try {
      const next = await chatApi.cancelChatGptAuth({ signal: controller.signal })
      if (disposed) return
      applyStatus(next)
      if (next.authFlow.status === 'idle') noticeText.value = '已取消本次 ChatGPT 登录。'
      if (next.planEnabled && !modelsLoaded.value && !loadingModels.value) void refreshModels()
      broadcastChange()
    } catch (error) {
      if (!disposed) errorText.value = errorMessage(error, '取消登录失败。')
    } finally {
      acting.value = false
    }
  }

  async function selectAccount(clientId: string) {
    if (disposed || !isLocalStudioHost() || acting.value) return
    acting.value = true
    errorText.value = ''
    noticeText.value = ''
    try {
      const next = await chatApi.selectChatGptAccount(clientId, { signal: controller.signal })
      if (disposed) return
      applyStatus(next)
      broadcastChange()
      if (next.signedIn && next.planEnabled) {
        void refreshModels()
      }
    } catch (error) {
      if (!disposed) errorText.value = errorMessage(error, '切换 ChatGPT 账号失败。')
    } finally {
      acting.value = false
    }
  }

  async function selectModel(slug: string) {
    const clientId = activeClientId.value
    if (disposed || acting.value || !clientId || !models.value.some(item => item.slug === slug)) return
    acting.value = true
    errorText.value = ''
    try {
      const next = await chatApi.setChatGptModel(clientId, slug, { signal: controller.signal })
      if (disposed) return
      applyStatus(next)
      broadcastChange()
    } catch (error) {
      if (!disposed) {
        errorText.value = errorMessage(error, '保存 ChatGPT 模型失败。')
        if (error instanceof ApiClientError && error.code === 'CHATGPT_MODEL_UNAVAILABLE') clearModels()
        void refreshStatus(true)
      }
    } finally {
      acting.value = false
    }
  }

  async function resumeUsage() {
    const clientId = activeClientId.value
    if (disposed || acting.value || !clientId || !usagePaused.value) return false
    acting.value = true
    errorText.value = ''
    try {
      const next = await chatApi.resumeChatGptUsage(clientId, { signal: controller.signal })
      if (disposed) return false
      applyStatus(next)
      noticeText.value = '已恢复发送 ChatGPT 对话。'
      broadcastChange()
      return true
    } catch (error) {
      if (!disposed) {
        errorText.value = errorMessage(error, '无法恢复发送，请稍后重试。')
        void refreshStatus(true)
      }
      return false
    } finally {
      acting.value = false
    }
  }

  async function signOut(clientId?: string) {
    if (disposed || !isLocalStudioHost() || acting.value) return
    acting.value = true
    errorText.value = ''
    noticeText.value = ''
    try {
      const result = await chatApi.signOutChatGpt(clientId, { signal: controller.signal })
      if (disposed) return
      applyStatus(result.status)
      noticeText.value = result.remoteRevoked
        ? '已退出当前 ChatGPT 会话，账号映射已保留便于下次快捷登录。'
        : '本地凭据已清除，但未能确认远程撤销；建议前往 ChatGPT 设置断开本应用。'
      broadcastChange()
    } catch (error) {
      if (!disposed) errorText.value = errorMessage(error, '退出 ChatGPT 登录失败。')
    } finally {
      acting.value = false
    }
  }

  async function removeAccount(clientId: string) {
    if (disposed || !isLocalStudioHost() || acting.value) return
    acting.value = true
    errorText.value = ''
    noticeText.value = ''
    try {
      const result = await chatApi.removeChatGptAccount(clientId, { signal: controller.signal })
      if (disposed) return
      applyStatus(result.status)
      if (result.status.planEnabled && !modelsLoaded.value) void refreshModels()
      noticeText.value = result.remoteRevoked
        ? '已移除该 ChatGPT 账号记录。'
        : '已移除本地账号记录，但未能确认远程撤销；可在 ChatGPT 设置中断开连接。'
      broadcastChange()
    } catch (error) {
      if (!disposed) errorText.value = errorMessage(error, '移除 ChatGPT 账号失败。')
    } finally {
      acting.value = false
    }
  }

  async function confirmWelcome() {
    welcomeOpen.value = false
    welcomeDismissed = true
    if (disposed || !isLocalStudioHost()) return
    try {
      const next = await chatApi.confirmChatGptWelcome({ signal: controller.signal })
      if (!disposed) {
        applyStatus(next)
        broadcastChange()
      }
    } catch { /* local dismissal already applied */ }
  }

  if (channel) {
    channel.onmessage = () => {
      if (!disposed && isLocalStudioHost()) void refreshStatus(true)
    }
  }

  if (getCurrentScope()) {
    onScopeDispose(() => {
      disposed = true
      stopPolling()
      controller.abort()
      modelsController?.abort()
      channel?.close()
    })
  }

  return {
    status,
    models,
    loadingStatus,
    loadingModels,
    acting,
    errorText,
    noticeText,
    welcomeOpen,
    activeAccount,
    activeClientId,
    signedIn,
    planEnabled,
    usagePaused,
    authPending,
    canRetryRegistration,
    selectedModel,
    selectedModelName,
    ready,
    statusText,
    refreshStatus,
    refreshModels,
    startSignIn: () => startAuth('new'),
    retryRegistration: () => startAuth('retry'),
    reauthorizeAccount: (clientId?: string) => startAuth('reauth', clientId),
    requestPlanConsent: (clientId?: string) => startAuth('consent', clientId),
    cancelAuth,
    selectAccount,
    selectModel,
    resumeUsage,
    refreshAfterRequest: () => {
      broadcastChange()
      return refreshStatus(true)
    },
    signOut,
    removeAccount,
    confirmWelcome,
  }
}

export type ChatGptAuthController = ReturnType<typeof useChatGptAuth>
