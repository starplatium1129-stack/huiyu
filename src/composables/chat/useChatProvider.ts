import { getDesktopCapabilities } from '../../platform/desktop/capabilities.ts'
import { profileLocalStorage as localStorage } from '../../platform/web/profileStorage.ts'
import { computed, getCurrentScope, onScopeDispose, ref, watch, type Ref } from 'vue'
import { useChatStorage, type ChatState } from './useChatStorage.ts'
import { parseChatStatus, type ChatModel } from '../../utils/chatStatus.ts'
import { DEEPSEEK_BASE_URL, DEEPSEEK_DEFAULT_MODEL } from '../../config/chatApi.ts'
import { STORAGE_KEY } from '../../config/characters.ts'
import { chatApi } from '../../api/chatApi.ts'
import { ApiClientError } from '../../api/client.ts'

export type ApiVendor = 'cliproxy' | 'deepseek' | 'opencode' | 'opencode-go' | 'custom'
type ChatStorage = ReturnType<typeof useChatStorage>

interface ChatProviderOptions {
  storage: ChatStorage
  isBusy: Ref<boolean>
}

export function useChatProvider({ storage, isBusy }: ChatProviderOptions) {
  const ollamaOnline = ref(false)
  const models = ref<ChatModel[]>([])
  const currentModel = ref('')
  const chatProvider = ref<'local' | 'api'>('local')
  const apiBaseUrl = ref(DEEPSEEK_BASE_URL)
  const apiModel = ref(DEEPSEEK_DEFAULT_MODEL)
  const apiKey = ref('')
  const apiVendor = ref<ApiVendor>('custom')
  const apiSettingsOpen = ref(false)
  const apiConfigHint = ref('')
  /** 站主托管配置（公网访客可直接使用，密钥留在服务端） */
  const hostApiConfigured = ref(false)
  const hostApiModel = ref('')
  const hostApiBaseUrl = ref('')
  const chatStatusText = ref('正在检查本地聊天模型…')
  const statusKind = ref('')

  function restoreSettings(state: ChatState) {
    currentModel.value = state.settings.model || ''
    chatProvider.value = state.settings.provider
    apiBaseUrl.value = state.settings.apiBaseUrl
    apiModel.value = state.settings.apiModel
    apiKey.value = state.settings.apiKey
    const savedApiBase = apiBaseUrl.value.replace(/\/+$/, '')
    apiVendor.value = savedApiBase === 'https://api.deepseek.com'
      ? 'deepseek'
      : savedApiBase === 'http://127.0.0.1:8317/v1' ? 'cliproxy'
      : savedApiBase === 'https://opencode.ai/zen/v1' ? 'opencode'
        : savedApiBase === 'https://opencode.ai/zen/go/v1' ? 'opencode-go' : 'custom'
    apiSettingsOpen.value = chatProvider.value === 'api' && !apiModel.value
  }

  restoreSettings(storage.state)
  watch(() => storage.state.settings.apiKey, value => { apiKey.value = value })

  /** 拉取站主托管配置（接口不回传密钥，只告知是否可用） */
  async function refreshHostConfig() {
    try {
      const data = await chatApi.getHostConfig()
      hostApiConfigured.value = data.configured
      hostApiModel.value = data.model || ''
      hostApiBaseUrl.value = data.baseUrl || ''
    } catch { /* 服务端不支持时静默降级 */ }
  }

  /** 本机：把当前本地配置保存为站主托管配置（访客直接可用） */
  async function saveHostConfig(): Promise<string> {
    if (!apiConfigured.value) return '请先完善本地 API 配置'
    try {
      await chatApi.saveHostConfig({
          baseUrl: apiBaseUrl.value,
          model: apiModel.value,
          apiKey: apiKey.value,
      })
      await refreshHostConfig()
      return '已保存为站主配置，公网访客可直接使用（密钥不会暴露）'
    } catch (error) {
      if (error instanceof ApiClientError) {
        if (error.kind === 'timeout') return '保存失败，请求超时'
        if (error.kind === 'network') return '保存失败，请检查网络'
        if (error.kind === 'aborted') return '保存失败，请求已取消'
        return error.status ? `保存失败：HTTP ${error.status}` : '保存失败，请检查网络'
      }
      return '保存失败，请检查网络'
    }
  }

  async function clearHostConfig(): Promise<void> {
    try { await chatApi.clearHostConfig() } catch {}
    hostApiConfigured.value = false
    hostApiModel.value = ''
  }

  const apiConfigured = computed(() =>
    Boolean(apiBaseUrl.value.trim() && apiModel.value.trim()
      && (apiVendor.value === 'custom' || apiKey.value.trim())),
  )
  /** 用户真实保存过自己的 API 配置（而非开箱即用的兜底默认值） */
  const apiConfiguredByUser = computed(() => !storage.neverConfigured.value)
  /** 访客模式：本地从未配置（或仅是兜底默认）且站主已托管时，使用站主配置 */
  const useHostConfig = computed(() =>
    chatProvider.value === 'api' && !apiConfiguredByUser.value && hostApiConfigured.value,
  )
  const chatReady = computed(() =>
    chatProvider.value === 'api'
      ? apiConfigured.value || hostApiConfigured.value
      : ollamaOnline.value,
  )

  function setChatStatus(text: string, kind = '') {
    chatStatusText.value = text
    statusKind.value = kind
  }

  async function refreshChatStatus() {
    try {
      const data = parseChatStatus(await chatApi.getStatus())
      ollamaOnline.value = data.online && Boolean(data.models.length)
      models.value = data.models
      if (!isBusy.value && chatProvider.value === 'local') {
        setChatStatus(ollamaOnline.value ? '本地聊天模型已连接' : 'Ollama 未启动', ollamaOnline.value ? 'online' : '')
      }
      const saved = storage.state.settings.model
      if (data.models.some(model => model.name === saved)) {
        currentModel.value = saved
      } else if (data.model || data.models[0]) {
        currentModel.value = data.model || data.models[0]?.name || ''
        storage.setModel(currentModel.value)
      }
      if (!data.models.length) {
        currentModel.value = ''
        if (chatProvider.value === 'local') setChatStatus('Ollama 未启动')
      }
    } catch {
      ollamaOnline.value = false
      models.value = []
      if (!isBusy.value && chatProvider.value === 'local') setChatStatus('Ollama 未启动')
    }
  }

  function apiStatusText(): string {
    if (useHostConfig.value) return `站主配置 · ${hostApiModel.value || 'API'}`
    return apiConfigured.value ? `自定义 API · ${apiModel.value}` : '等待配置自定义 API'
  }

  function setChatProvider(provider: 'local' | 'api') {
    if (isBusy.value || chatProvider.value === provider) return
    chatProvider.value = provider
    storage.setProvider(provider)
    apiConfigHint.value = ''
    if (provider === 'api') {
      apiSettingsOpen.value = !apiConfigured.value && !hostApiConfigured.value
      setChatStatus(apiStatusText(), (apiConfigured.value || hostApiConfigured.value) ? 'online' : '')
    } else {
      setChatStatus(ollamaOnline.value ? '本地聊天模型已连接' : 'Ollama 未启动', ollamaOnline.value ? 'online' : '')
    }
  }

  async function saveApiSettings() {
    if (!apiConfigured.value) {
      apiConfigHint.value = apiVendor.value !== 'custom'
        ? `请填写 ${apiVendor.value === 'opencode' ? 'OpenCode Zen' : apiVendor.value === 'opencode-go' ? 'OpenCode Go' : 'DeepSeek'} API Key。`
        : '请填写 API 地址和模型名。'
      return
    }
    try {
      await storage.setApiSettings({ baseUrl: apiBaseUrl.value, model: apiModel.value, apiKey: apiKey.value })
    } catch {
      apiConfigHint.value = '安全凭据保存失败，原配置已保留，请重试。'
      return
    }
    apiConfigHint.value = getDesktopCapabilities() ? '配置已保存，密钥由 Windows 凭据管理器保护。' : '配置已保存，密钥仅用于当前页面会话。'
    apiSettingsOpen.value = false
    setChatStatus(`自定义 API · ${apiModel.value}`, 'online')
  }

  async function clearApiCredential() {
    try {
      await storage.setApiSettings({ baseUrl: apiBaseUrl.value, model: apiModel.value, apiKey: '' })
      apiKey.value = ''
      apiConfigHint.value = '个人密钥已清除。'
    } catch { apiConfigHint.value = '个人密钥清除失败，原配置已保留，请重试。' }
  }

  function setBusyStatus(value: boolean) {
    isBusy.value = value
    if (value) setChatStatus('正在生成回复…', 'busy')
    else if (chatProvider.value === 'api') {
      setChatStatus(apiStatusText(), (apiConfigured.value || hostApiConfigured.value) ? 'online' : '')
    } else {
      setChatStatus(ollamaOnline.value ? '本地聊天模型已连接' : '聊天模型未连接', ollamaOnline.value ? 'online' : '')
    }
  }

  // 跨窗口配置同步：在 Atelier 聊天页保存配置后，已打开的 Companion 悬浮窗
  // （或另一个标签页）立即生效。storage 事件只由其他窗口的写入触发，本窗口
  // 只读不写，不会循环。
  function syncApiSettingsFromStorage(event: StorageEvent) {
    if (event.storageArea !== localStorage) return
    if (event.key !== null && event.key !== STORAGE_KEY && event.key !== 'aics_chat_model') return
    restoreSettings(storage.state)
    setChatStatus(apiStatusText(), (apiConfigured.value || hostApiConfigured.value) ? 'online' : '')
    void refreshHostConfig()
  }
  window.addEventListener('storage', syncApiSettingsFromStorage)
  if (getCurrentScope()) {
    onScopeDispose(() => window.removeEventListener('storage', syncApiSettingsFromStorage))
  }

  return {
    ollamaOnline, models, currentModel, chatProvider, apiBaseUrl, apiModel, apiKey,
    apiVendor, apiSettingsOpen, apiConfigHint, chatStatusText, statusKind,
    hostApiConfigured, hostApiModel, hostApiBaseUrl, useHostConfig,
    apiConfigured, apiConfiguredByUser, chatReady, refreshChatStatus, refreshHostConfig,
    saveHostConfig, clearHostConfig,
    setChatProvider, saveApiSettings, clearApiCredential,
    setChatStatus, setBusy: setBusyStatus,
  }
}
