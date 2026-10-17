import { computed, onScopeDispose, ref, type Ref } from 'vue'
import { createChatCredentials } from '@/utils/chatCredentials'
import { CHAT_SEARCH_KEY } from '@/utils/storageKeys'
import type { ChatSearchProvider } from '@/config/chatSearch'
import { chatApiVendorFor } from '@/config/chatApi'
import { loadChatSearchSettings, saveChatSearchSettings, readChatSearchPreference } from '@/utils/chatSearchStorage'
import { isLocalStudioHost } from '@/utils/runtimeEnvironment'
import { maintenanceFrozen, registerMaintenanceParticipant } from '@/platform/maintenanceParticipants'

export function useChatSearchSettings(connection: {
  apiBaseUrl: Ref<string>; apiKey: Ref<string>; useHostConfig: Ref<boolean>; hostApiBaseUrl: Ref<string>; busy: Ref<boolean>
}) {
  const credentials = createChatCredentials()
  const provider = ref<ChatSearchProvider>('auto'), apiKey = ref('')
  const draftProvider = ref<ChatSearchProvider>('auto'), draftKey = ref('')
  const loading = ref(false), saving = ref(false), error = ref(''), notice = ref(''), loadError = ref(false)
  const ready = computed(() => !loading.value && !saving.value && !loadError.value)
  const locked = computed(() => connection.busy.value || loading.value || saving.value)
  let disposed = false, revision = '', reloadPending = false
  const source = computed(() => {
    if (!ready.value) return '配置未就绪'
    if (provider.value === 'duckduckgo') return 'DuckDuckGo'
    if (apiKey.value) return 'DeepSeek · 独立搜索密钥'
    const address = connection.useHostConfig.value ? connection.hostApiBaseUrl.value : connection.apiBaseUrl.value
    return chatApiVendorFor(address) === 'deepseek' && (connection.useHostConfig.value || connection.apiKey.value)
      ? 'DeepSeek · 复用聊天密钥' : 'DuckDuckGo'
  })

  async function reload() {
    if (!isLocalStudioHost() || disposed) return
    if (saving.value || loading.value) { reloadPending = true; return }
    loading.value = true; error.value = ''; notice.value = ''
    const clean = draftProvider.value === provider.value && draftKey.value === apiKey.value
    try {
      const saved = await loadChatSearchSettings()
      if (disposed) return
      provider.value = saved.provider; apiKey.value = saved.apiKey; revision = saved.revision
      if (clean) { draftProvider.value = provider.value; draftKey.value = saved.apiKey }
      loadError.value = false
    } catch (cause) {
      if (!disposed) { loadError.value = true; error.value = cause instanceof Error ? cause.message : '搜索配置读取失败，请重试。' }
    } finally {
      loading.value = false
      if (reloadPending && !disposed) { reloadPending = false; void reload() }
    }
  }

  async function save(clearKey = false) {
    if (locked.value || maintenanceFrozen()) return
    const secret = clearKey ? '' : draftKey.value.trim()
    const selected = draftProvider.value
    saving.value = true; error.value = ''; notice.value = ''
    try {
      const nextRevision = await saveChatSearchSettings(selected, secret)
      if (disposed) return
      provider.value = selected; apiKey.value = secret; draftKey.value = secret; revision = nextRevision
      loadError.value = false; notice.value = clearKey ? '独立搜索密钥已清除。' : '搜索设置已保存。'
    } catch (cause) {
      if (!disposed) { loadError.value = true; error.value = cause instanceof Error ? cause.message : '搜索设置未能保存，请重试。' }
    } finally {
      saving.value = false
      if (reloadPending && !disposed) { reloadPending = false; void reload() }
    }
  }

  function onStorage(event: StorageEvent) {
    if (event.key !== CHAT_SEARCH_KEY) return
    try {
      if (readChatSearchPreference().revision !== revision) void reload()
    } catch { void reload() }
  }
  window.addEventListener('storage', onStorage)
  const release = registerMaintenanceParticipant(() => { if (saving.value) throw new Error('SEARCH_SETTINGS_BUSY') })
  onScopeDispose(() => { disposed = true; apiKey.value = ''; draftKey.value = ''; window.removeEventListener('storage', onStorage); release() })
  void reload()
  return { provider, apiKey, draftProvider, draftKey, loading, saving, ready, locked, error, notice, source,
    desktopCredentials: credentials.desktop, save, reload }
}
