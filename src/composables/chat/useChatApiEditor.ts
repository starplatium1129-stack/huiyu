import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { chatApi } from '@/api/chatApi'
import { ApiClientError } from '@/api/client'
import { CHAT_API_PRESETS, chatApiAddressError, chatApiEndpoint, chatApiPreset, isOpenRouterFreeModel, type ApiVendor } from '@/config/chatApi'
import { createChatApiDrafts } from '@/utils/chatApiDrafts'

export interface ChatApiEditorProps {
  readonly vendor: ApiVendor
  readonly baseUrl: string
  readonly model: string
  readonly apiKey: string
  readonly credentialsLoading?: boolean
  readonly busy?: boolean
  readonly hint?: string
}
interface EditorEmit {
  (event: 'update:vendor', value: ApiVendor): void
  (event: 'update:baseUrl', value: string): void
  (event: 'update:model', value: string): void
  (event: 'update:apiKey', value: string): void
  (event: 'clear-key'): void
}

export function useChatApiEditor(props: ChatApiEditorProps, emit: EditorEmit) {
  const preset = computed(() => chatApiPreset(props.vendor))
  const addressError = computed(() => chatApiAddressError(props.baseUrl))
  const fetchingModels = ref(false)
  const clearingKey = ref(false)
  const state = ref('')
  const message = ref('')
  const authenticationRequired = ref(false)
  const credentialRejected = ref(false)
  const discoveredModels = ref<string[]>([])
  const freeModelsOnly = ref(true)
  const filteringFreeModels = computed(() => props.vendor === 'openrouter' && freeModelsOnly.value)
  const connectionOpen = ref(false)
  let draftRevision = 0
  let vendorSelection = 0
  let controller: AbortController | null = null

  function invalidate(clearModels = true) {
    draftRevision++
    controller?.abort()
    controller = null
    fetchingModels.value = false
    state.value = ''
    message.value = ''
    if (clearModels) discoveredModels.value = []
  }
  watch(() => [props.vendor, props.baseUrl, props.apiKey], () => invalidate(), { flush: 'sync' })
  watch(() => [props.vendor, props.baseUrl], () => { authenticationRequired.value = false; credentialRejected.value = false }, { flush: 'sync' })
  watch(() => props.apiKey, () => { credentialRejected.value = false }, { flush: 'sync' })
  watch(() => [props.model, freeModelsOnly.value], () => invalidate(false), { flush: 'sync' })
  onBeforeUnmount(invalidate)
  watch(() => props.vendor, () => {
    freeModelsOnly.value = !props.model.trim() || isOpenRouterFreeModel(props.model.trim())
    connectionOpen.value = props.vendor === 'custom' || Boolean(addressError.value)
      || chatApiEndpoint(props.baseUrl) !== chatApiEndpoint(preset.value.baseUrl)
  }, { immediate: true, flush: 'post' })
  watch(addressError, error => { if (error) connectionOpen.value = true })

  const drafts = createChatApiDrafts(() => {
    state.value = 'warning'
    message.value = '密钥迁移未完成，原值已保留，请重试。'
  })
  const baseUrlProxy = computed({ get: () => props.baseUrl, set: value => { invalidate(); emit('update:baseUrl', value) } })
  const modelProxy = computed({ get: () => props.model, set: value => { invalidate(false); emit('update:model', value) } })
  const apiKeyProxy = computed({ get: () => props.apiKey, set: value => { invalidate(); emit('update:apiKey', value) } })
  const needsKey = computed(() => preset.value.keyRequired || authenticationRequired.value)
  const locked = computed(() => Boolean(props.busy || props.credentialsLoading || fetchingModels.value || clearingKey.value))
  const connectionHint = computed(() => props.busy ? '回复结束后可修改配置。'
    : props.credentialsLoading ? '正在读取密钥…'
      : clearingKey.value ? '正在清除密钥…'
        : addressError.value || (credentialRejected.value ? '请重新填写有效密钥。' : needsKey.value && !props.apiKey.trim() ? '先填写 API 密钥。' : ''))
  const canFetchModels = computed(() => !locked.value && !connectionHint.value)
  const saveHint = computed(() => connectionHint.value || (!props.model.trim() ? '选择或填写一个模型。'
    : filteringFreeModels.value && !isOpenRouterFreeModel(props.model.trim()) ? '请选择免费模型，或关闭“只选免费模型”。' : ''))
  const canSave = computed(() => !locked.value && !saveHint.value)
  const modelOptions = computed(() => {
    const options = discoveredModels.value.length
      ? discoveredModels.value.map(value => ({ value, label: value })) : preset.value.models
    if (props.vendor !== 'openrouter') return options
    const choices = [...preset.value.models, ...options.filter(option => !preset.value.models.some(item => item.value === option.value))]
    return filteringFreeModels.value ? choices.filter(option => isOpenRouterFreeModel(option.value)) : choices
  })
  const usageNote = computed(() => props.vendor === 'openrouter'
    ? isOpenRouterFreeModel(props.model.trim()) ? '免费模型，有使用额度限制。' : '当前模型按 OpenRouter 价格计费。'
    : preset.value.freeTier ? '免费账户可用；已开通付费的账户按其方案计费。'
      : props.vendor === 'openai' ? 'API 单独计费。' : '按服务商规则计费。')
  const statusText = computed(() => props.credentialsLoading ? '正在读取密钥…' : message.value || '')
  const providerGroups = [
    { label: '免费模型与额度', options: CHAT_API_PRESETS.filter(item => item.freeTier) },
    { label: '本机服务', options: CHAT_API_PRESETS.filter(item => item.local) },
    { label: '云端服务', options: CHAT_API_PRESETS.filter(item => !item.freeTier && !item.local && item.value !== 'custom' && item.value !== 'opencode-go') },
    { label: '其他', options: CHAT_API_PRESETS.filter(item => item.value === 'custom' || item.value === 'opencode-go') },
  ]

  async function selectVendor(vendor: ApiVendor) {
    const selection = ++vendorSelection
    if (vendor === props.vendor || locked.value) return
    invalidate()
    const revision = draftRevision
    await drafts.ready
    if (locked.value || selection !== vendorSelection || revision !== draftRevision) return
    drafts.set(props.vendor, { baseUrl: props.baseUrl, model: props.model, apiKey: props.apiKey })
    const saved = drafts.drafts.value[vendor]
    const target = chatApiPreset(vendor)
    emit('update:vendor', vendor)
    emit('update:apiKey', saved?.apiKey || '')
    emit('update:baseUrl', saved?.baseUrl ?? target.baseUrl)
    emit('update:model', saved?.model ?? target.models[0]?.value ?? '')
  }

  async function clearPersonalKey() {
    if (locked.value) return
    clearingKey.value = true
    const revision = draftRevision
    try {
      await drafts.clear(props.vendor, { baseUrl: props.baseUrl, model: props.model, apiKey: props.apiKey })
      if (revision !== draftRevision) return
      emit('update:apiKey', '')
      emit('clear-key')
    } catch {
      if (revision === draftRevision) { state.value = 'error'; message.value = '密钥清除未完成，请重试。' }
    } finally { clearingKey.value = false }
  }

  function connectionError(error: unknown): string {
    if (!(error instanceof ApiClientError)) return '无法获取模型，请检查服务地址和网络。'
    if (error.code === 'LOCAL_ONLY') return '请在运行绘遇的电脑上配置；访客可使用站主配置。'
    if (error.kind === 'timeout' || error.code === 'UPSTREAM_TIMEOUT') return '获取超时，请确认服务已启动后重试。'
    if (error.code === 'UPSTREAM_UNAVAILABLE' || error.kind === 'network') return preset.value.local
      ? '无法连接本机服务，请先启动服务，并检查端口。' : '无法连接服务，请检查地址、网络或代理。'
    if (error.status === 401) return props.apiKey.trim() ? '密钥无效，请重新填写。' : '服务需要访问密钥，填写后再获取模型。'
    if (error.status === 404 || error.status === 405) return '此地址未提供模型列表，可直接填写模型名，或修改连接地址。'
    if (error.code?.startsWith('UPSTREAM_') || error.code?.startsWith('OPENCODE_')) return error.message
    if (error.status === 403) return '服务拒绝访问，请核对模型权限、地域和服务商的使用限制。'
    if (error.status === 402) return 'API 额度不足，请检查服务商账户。'
    if (error.status === 429) return '请求过于频繁或额度受限，请稍后重试。'
    if (error.code === 'INVALID_MODEL_LIST' || error.kind === 'invalid-response') return '这个地址没有返回模型列表，请确认填写的是 API 地址。'
    if (error.status === 400) return '配置格式无效，请检查连接地址，密钥请填在专用输入框。'
    return '获取失败，请核对服务商的接入说明后重试。'
  }

  function cancelFetch() {
    controller?.abort()
    controller = null
    fetchingModels.value = false
    state.value = ''
    message.value = '已取消获取。'
  }

  async function fetchModels() {
    if (!canFetchModels.value) return
    const request = new AbortController()
    controller = request
    fetchingModels.value = true
    state.value = 'loading'
    message.value = '正在获取模型…'
    try {
      const data = await chatApi.testProvider({ baseUrl: props.baseUrl, model: props.model, apiKey: props.apiKey }, { signal: request.signal })
      if (controller !== request || request.signal.aborted) return
      discoveredModels.value = [...new Set(data.models.map(model => model.trim()).filter(Boolean))]
      const missing = props.model.trim() && !modelOptions.value.some(option => option.value === props.model.trim())
      state.value = discoveredModels.value.length && !missing ? 'success' : 'warning'
      message.value = !discoveredModels.value.length ? (filteringFreeModels.value
        ? '目录未列出模型，仍可选择免费自动选择；实际可用性以聊天结果为准。' : '没有可选模型，可直接填写模型名。')
        : missing ? `发现 ${discoveredModels.value.length} 个模型，当前填写的模型未列出。`
          : filteringFreeModels.value ? `可选 ${modelOptions.value.length} 个免费模型（含自动选择）。` : `已获取 ${discoveredModels.value.length} 个模型。`
    } catch (error) {
      if (controller !== request || request.signal.aborted) return
      state.value = 'error'
      message.value = connectionError(error)
      if (error instanceof ApiClientError && error.status === 401) {
        authenticationRequired.value = true
        credentialRejected.value = true
        connectionOpen.value = true
      }
      if (error instanceof ApiClientError && [400, 404, 405].includes(error.status)) connectionOpen.value = true
    } finally {
      if (controller === request) { controller = null; fetchingModels.value = false }
    }
  }

  return { preset, needsKey, providerGroups, addressError, baseUrlProxy, modelProxy, apiKeyProxy, locked, connectionOpen,
    fetchingModels, clearingKey, state, statusText, modelOptions, freeModelsOnly, filteringFreeModels, usageNote, connectionHint, saveHint, canFetchModels, canSave,
    selectVendor, fetchModels, cancelFetch, clearPersonalKey }
}
