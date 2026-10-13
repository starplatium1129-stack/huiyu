<template>
  <form class="api-settings" @submit.prevent="canSaveHost && emit('save')">
    <div class="api-settings-head">
      <div class="api-title-lockup">
        <span class="api-mark" aria-hidden="true"><ArchiveIcon name="chat" /></span>
        <div>
          <strong>连接对话模型</strong>
        </div>
      </div>
      <span class="api-storage-note"><i aria-hidden="true"></i>{{ desktopCredentials ? '密钥由 Windows 安全保存' : '密钥仅用于当前页面会话' }}</span>
    </div>

    <label class="api-field">
      <span>服务商</span>
      <StudioSelect :model-value="vendor" label="服务商" :options="CHAT_API_PRESETS"
        :disabled="credentialsLoading" @update:model-value="selectVendor($event as ApiVendor)" />
    </label>

    <div v-if="preset.local || preset.keyUrl || preset.docsUrl" class="api-provider-help">
      <p v-if="preset.local">本机地址连接运行绘遇的电脑。</p>
      <div class="api-help-links">
        <a v-if="preset.keyUrl" :href="preset.keyUrl" target="_blank" rel="noopener noreferrer">获取密钥（新窗口）</a>
        <a v-if="preset.docsUrl" :href="preset.docsUrl" target="_blank" rel="noopener noreferrer">官方说明（新窗口）</a>
      </div>
    </div>

    <div class="api-settings-grid">
      <label class="api-field">
        <span>API 地址（OpenAI 兼容）</span>
        <input v-model.trim="baseUrlProxy" type="url" maxlength="500"
          placeholder="https://api.example.com/v1" autocomplete="url" required :aria-invalid="Boolean(addressError)" aria-describedby="api-address-help" />
        <small id="api-address-help">{{ addressError || '请确认地址与密钥属于同一服务商。' }}</small>
      </label>
      <label class="api-field">
        <span>模型 ID</span>
        <input v-model.trim="modelProxy" maxlength="200" aria-label="模型名"
          placeholder="输入或从模型列表选择" autocomplete="off" required />
      </label>
      <label class="api-field">
        <span>API Key{{ preset.keyRequired ? '' : '（未设认证可留空）' }}</span>
        <div class="api-key-field">
          <input v-model.trim="apiKeyProxy" :type="showApiKey ? 'text' : 'password'"
            maxlength="1000" placeholder="sk-…" autocomplete="off"
            :required="preset.keyRequired" aria-label="API Key" spellcheck="false" />
          <button type="button" :aria-label="showApiKey ? '隐藏 API Key' : '显示 API Key'" :aria-pressed="showApiKey" @click="showApiKey = !showApiKey">{{ showApiKey ? '隐藏' : '显示' }}</button>
        </div>
      </label>
      <div v-if="modelOptions.length" class="api-field api-discovered-models">
        <span>{{ discoveredModels.length ? '可选模型' : '参考模型' }}</span>
        <StudioSelect :model-value="modelProxy" label="选择模型 ID" :options="modelOptions"
          placeholder="选择模型" @update:model-value="modelProxy = String($event)" />
      </div>
      <p class="api-model-note">{{ vendor === 'openai' ? 'API 单独计费，不使用 ChatGPT 订阅额度。' : '使用云端模型时，按服务商规则计费。' }}</p>
    </div>

    <div class="api-settings-actions">
      <span v-if="statusText" class="api-test-status" :data-state="testState" role="status">{{ statusText }}</span>
      <div class="api-settings-buttons">
        <button class="btn btn-ghost btn-sm" type="button" :disabled="clearingKey" @click="clearPersonalKey">
          {{ clearingKey ? '清除中…' : '清除个人密钥' }}
        </button>
        <button class="btn btn-ghost btn-sm" type="button"
          :disabled="testing || !canTest" @click="testConnection">
          {{ testing ? '获取中…' : '获取模型列表' }}
        </button>
        <button class="btn btn-primary btn-sm" type="submit" :disabled="!canSaveHost || testing">保存并使用</button>
      </div>
    </div>
    <details v-if="isLocalHost" class="api-host-advanced">
      <summary>共享给访客</summary>
      <p>访客将使用你的模型与额度，密钥保留在后端。</p>
      <div class="api-host-row">
      <button class="btn btn-ghost btn-sm" type="button" :disabled="!canSaveHost" @click="emit('save-host')">
        <ArchiveIcon name="upload" /> 共享当前配置
      </button>
      <button v-if="hostConfigured" class="btn btn-ghost btn-sm" type="button" @click="emit('clear-host')">
        <ArchiveIcon name="close" /> 清除站主配置
      </button>
    </div>
    </details>
    <p v-else-if="hostConfigured" class="api-host-hint">
      <ArchiveIcon name="lock" /> 站主已配置模型（{{ hostModel }}），无需密钥即可对话；密钥不会被传输或显示。
    </p>
  </form>
</template>

<script setup lang="ts">
import { getDesktopCapabilities } from '@/platform/desktop/capabilities'

import { computed, ref, watch, onBeforeUnmount, onUnmounted } from 'vue'
import { registerMaintenanceParticipant } from '@/platform/maintenanceParticipants'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import { CHAT_API_PRESETS, chatApiPreset, chatApiAddressError, type ApiVendor } from '@/config/chatApi'
import { chatApi } from '@/api/chatApi'
import { ApiClientError } from '@/api/client'
import { createChatApiDrafts } from '@/utils/chatApiDrafts'

const props = defineProps<{
  vendor: ApiVendor
  baseUrl: string
  model: string
  apiKey: string
  credentialsLoading?: boolean
  hint?: string
  isLocalHost?: boolean
  hostConfigured?: boolean
  hostModel?: string
}>()

const emit = defineEmits<{
  'update:vendor': [value: ApiVendor]
  'update:baseUrl': [value: string]
  'update:model': [value: string]
  'update:apiKey': [value: string]
  save: []
  'save-host': []
  'clear-host': []
  'clear-key': []
}>()

const showApiKey = ref(false)
onUnmounted(registerMaintenanceParticipant(() => { throw new Error('OPEN_API_SETTINGS') }))
const desktopCredentials = Boolean(getDesktopCapabilities())
const testing = ref(false)
const testState = ref('')
const testMessage = ref('')
const discoveredModels = ref<string[]>([])
let draftRevision = 0
let vendorSelection = 0
const clearingKey = ref(false)
let testController: AbortController | null = null
function invalidateTest(clearModels = true) {
  draftRevision++
  testController?.abort()
  testController = null
  testing.value = false
  testState.value = ''
  testMessage.value = ''
  if (clearModels) discoveredModels.value = []
}
watch(() => [props.vendor, props.baseUrl, props.apiKey], () => invalidateTest(), { flush: 'sync' })
watch(() => props.model, () => invalidateTest(false), { flush: 'sync' })
onBeforeUnmount(invalidateTest)
const draftStore = createChatApiDrafts(() => { testMessage.value = '旧密钥草稿暂未能安全迁移，原值已保留，请重试。' })
const vendorDrafts = draftStore.drafts

async function clearPersonalKey() {
  if (clearingKey.value) return
  clearingKey.value = true
  const revision = draftRevision
  try {
    await draftStore.clear(props.vendor, { baseUrl: props.baseUrl, model: props.model, apiKey: props.apiKey })
    if (revision !== draftRevision) return
    emit('update:apiKey', '')
    emit('clear-key')
  } catch {
    if (revision === draftRevision) {
      testState.value = 'error'
      testMessage.value = '个人密钥草稿清除尚未确认，请检查后重试。'
    }
  } finally { clearingKey.value = false }
}

const baseUrlProxy = computed({
  get: () => props.baseUrl,
  set: value => { invalidateTest(); emit('update:baseUrl', value) },
})
const modelProxy = computed({
  get: () => props.model,
  set: value => { invalidateTest(false); emit('update:model', value) },
})
const apiKeyProxy = computed({
  get: () => props.apiKey,
  set: value => { invalidateTest(); emit('update:apiKey', value) },
})

const preset = computed(() => chatApiPreset(props.vendor))
const addressError = computed(() => chatApiAddressError(props.baseUrl))
const canTest = computed(() => !addressError.value && (!preset.value.keyRequired || Boolean(props.apiKey.trim())))
const canSaveHost = computed(() => canTest.value && Boolean(props.model.trim()))
const modelOptions = computed(() => discoveredModels.value.length
  ? discoveredModels.value.map(value => ({ value, label: value }))
  : preset.value.models)
const statusText = computed(() => props.credentialsLoading ? '正在读取密钥…' : testMessage.value || props.hint || '')

function connectionError(error: unknown): string {
  if (!(error instanceof ApiClientError)) return '连接测试失败，请检查地址、服务是否启动和网络后重试。'
  if (error.code === 'LOCAL_ONLY') return '连接测试仅限绘遇所在电脑直连；远程访客请联系站主配置。'
  if (error.kind === 'timeout' || error.code === 'UPSTREAM_TIMEOUT') return '连接测试超时，请检查网络或服务是否正在启动，然后重试。'
  if (error.code === 'UPSTREAM_UNAVAILABLE' || error.kind === 'network') return preset.value.local
    ? '无法连接本机服务，请启动服务并核对地址。'
    : '无法连接服务，请检查 API 地址、网络和代理设置。'
  if (error.status === 401) return '密钥无效，请重新填写当前服务商的密钥。'
  if (error.status === 403) return '访问被拒绝，请检查账号和 API 权限。'
  if (error.status === 402) return '额度不足或尚未开通 API 计费，请到服务商控制台检查。'
  if (error.status === 404 || error.status === 405) return '模型目录不可用，请核对 Base URL；部分兼容服务不提供 /models，可手填官方模型 ID 后保存。'
  if (error.status === 429) return '请求过于频繁或额度受限，请稍后重试。'
  if (error.code === 'INVALID_MODEL_LIST' || error.kind === 'invalid-response') return '服务返回的内容不是模型目录，请检查地址是否填成了网页或不兼容的接口。'
  if (error.status === 400) return '配置格式无效，请核对地址和模型 ID；地址中不要携带密钥或查询参数。'
  return '连接测试失败，服务可能暂时不可用；请核对官方接入说明后重试。'
}

async function selectVendor(vendor: ApiVendor) {
  const selection = ++vendorSelection
  if (vendor === props.vendor || props.credentialsLoading) return
  invalidateTest()
  const revision = draftRevision
  await draftStore.ready
  if (props.credentialsLoading || selection !== vendorSelection || revision !== draftRevision) return
  showApiKey.value = false
  const current = props.vendor
  // 先把当前商家的草稿存起来
  draftStore.set(current, {
    baseUrl: props.baseUrl,
    model: props.model,
    apiKey: props.apiKey,
  })
  emit('update:vendor', vendor)
  discoveredModels.value = []
  testState.value = ''
  testMessage.value = ''

  // 目标商家有草稿就恢复，没有才填预设
  const saved = vendorDrafts.value[vendor]
  if (saved) {
    emit('update:baseUrl', saved.baseUrl)
    emit('update:model', saved.model)
    emit('update:apiKey', saved.apiKey)
    return
  }
  // Credentials belong to their provider draft; never carry a key to a new endpoint.
  const target = chatApiPreset(vendor)
  emit('update:apiKey', '')
  emit('update:baseUrl', target.baseUrl)
  emit('update:model', target.models[0]?.value || '')
}

async function testConnection() {
  if (!canTest.value || testing.value) return
  const controller = new AbortController()
  testController = controller
  testing.value = true
  testState.value = 'testing'
  testMessage.value = '正在获取模型列表…'
  try {
    const data = await chatApi.testProvider({
        baseUrl: props.baseUrl,
        model: props.model,
        apiKey: props.apiKey,
    }, { signal: controller.signal })
    if (testController !== controller || controller.signal.aborted) return
    discoveredModels.value = Array.isArray(data.models)
      ? [...new Set(data.models.map(model => String(model).trim()).filter(Boolean))]
      : []
    const missing = props.model.trim() && !discoveredModels.value.includes(props.model.trim())
    testState.value = discoveredModels.value.length && !missing ? 'success' : 'warning'
    testMessage.value = !discoveredModels.value.length
      ? '未找到可选模型，可手填模型 ID。'
      : missing
        ? `找到 ${discoveredModels.value.length} 个模型，当前模型未列出，请核对模型 ID。`
        : `找到 ${discoveredModels.value.length} 个模型，请选择聊天模型并保存。`
  } catch (error) {
    if (testController !== controller || controller.signal.aborted) return
    testState.value = 'error'
    // Provider error bodies may echo credentials or request URLs; never render them.
    testMessage.value = connectionError(error)
  } finally {
    if (testController === controller) { testController = null; testing.value = false }
  }
}
</script>

<style scoped>
.api-provider-help, .api-host-advanced { color:var(--text-secondary); font-size:var(--fs-label-sm); line-height:1.6; }
.api-provider-help p, .api-host-advanced p { margin:0 0 var(--s-2); }
.api-help-links { display:flex; flex-wrap:wrap; gap:var(--s-2) var(--s-4); }
.api-help-links a { color:var(--character-ink, var(--accent)); text-decoration:underline; text-underline-offset:3px; }
.api-host-advanced summary { cursor:pointer; padding:var(--s-2) 0; }
.api-test-status[data-state="warning"] { color:var(--warning-text); }
.api-settings-buttons { flex-wrap:wrap; }
</style>
