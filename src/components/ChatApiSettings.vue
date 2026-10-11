<template>
  <form class="api-settings" @submit.prevent="canSaveHost && emit('save')">
    <div class="api-settings-head">
      <div class="api-title-lockup">
        <span class="api-mark" aria-hidden="true"><ArchiveIcon name="chat" /></span>
        <div>
          <small>MODEL GATEWAY</small>
          <strong>连接对话模型</strong>
          <span>选服务商 → 获取密钥 → 测试并选模型 → 保存。</span>
        </div>
      </div>
      <span class="api-storage-note"><i aria-hidden="true"></i>{{ desktopCredentials ? '密钥由 Windows 安全保存' : '密钥仅用于当前页面会话' }}</span>
    </div>

    <fieldset class="api-vendor-picker">
      <legend>服务商</legend>
      <button
        v-for="option in CHAT_API_PRESETS"
        :key="option.value"
        type="button"
        :data-vendor="option.value"
        :class="{ active: vendorProxy === option.value }"
        :aria-pressed="vendorProxy === option.value"
        @click="selectVendor(option.value)"
      >
        <span>{{ option.label }}</span>
        <small>{{ option.note }}</small>
      </button>
    </fieldset>

    <div class="api-provider-help">
      <p>{{ preset.help }}</p>
      <p v-if="preset.local">本机地址指运行绘遇后端的电脑；在另一台电脑打开网页，不会连接那台电脑上的模型。绘遇受管 llama.cpp 请在控制室准备，无需手填密钥。</p>
      <div class="api-help-links">
        <a v-if="preset.keyUrl" :href="preset.keyUrl" target="_blank" rel="noopener noreferrer">获取 {{ preset.label }} API Key（新窗口）</a>
        <a v-if="preset.docsUrl" :href="preset.docsUrl" target="_blank" rel="noopener noreferrer">官方接入说明（新窗口）</a>
      </div>
    </div>

    <div class="api-settings-grid">
      <label class="api-field">
        <span><i aria-hidden="true">01</i> API 地址</span>
        <input v-model.trim="baseUrlProxy" type="url" maxlength="500"
          placeholder="https://api.example.com/v1" autocomplete="url" required :aria-invalid="Boolean(addressError)" aria-describedby="api-address-help" />
        <small id="api-address-help">{{ addressError || '填写 Base URL；绘遇会补上 /chat/completions。修改地址前请确认密钥属于该服务。' }}</small>
      </label>
      <label class="api-field">
        <span><i aria-hidden="true">02</i> 模型</span>
        <input v-model.trim="modelProxy" maxlength="200" aria-label="模型名"
          placeholder="可先测试连接，再从列表选择模型" autocomplete="off" required />
        <small>填写准确模型 ID；可手填新模型，已有配置会保留。</small>
      </label>
      <label class="api-field">
        <span><i aria-hidden="true">03</i> API Key{{ preset.keyRequired ? '' : '（未设认证时可留空）' }}</span>
        <div class="api-key-field">
          <input v-model.trim="apiKeyProxy" :type="showApiKey ? 'text' : 'password'"
            maxlength="1000" placeholder="sk-…" autocomplete="off"
            :required="preset.keyRequired" aria-label="API Key" spellcheck="false" />
          <button type="button" :aria-label="showApiKey ? '隐藏 API Key' : '显示 API Key'" :aria-pressed="showApiKey" @click="showApiKey = !showApiKey">{{ showApiKey ? '隐藏' : '显示' }}</button>
        </div>
      </label>
      <div v-if="modelOptions.length" class="api-field api-discovered-models">
        <span>{{ discoveredModels.length ? '服务返回的模型列表' : '官方参考模型' }}</span>
        <StudioSelect :model-value="modelProxy" label="选择模型 ID" :options="modelOptions"
          placeholder="选择模型以填入上方" @update:model-value="modelProxy = String($event)" />
      </div>
      <p class="api-model-note">{{ modelNote }}</p>
      <p class="api-model-note">测试只请求模型目录，不发送对话，不产生文本生成费用；不验证余额、生成权限或每个模型的工具兼容性。实际发送消息按服务商规则计费。</p>
    </div>

    <div class="api-settings-actions">
      <span class="api-test-status" :data-state="testState" role="status">{{ statusText }}</span>
      <div class="api-settings-buttons">
        <button class="btn btn-ghost btn-sm" type="button" :disabled="clearingKey" @click="clearPersonalKey">
          {{ clearingKey ? '清除中…' : '清除个人密钥' }}
        </button>
        <button class="btn btn-ghost btn-sm" type="button"
          :disabled="testing || !canTest" @click="testConnection">
          {{ testing ? '测试中…' : '测试连接' }}
        </button>
        <button class="btn btn-primary btn-sm" type="submit" :disabled="!canSaveHost || testing">保存并使用</button>
      </div>
    </div>
    <details v-if="isLocalHost" class="api-host-advanced">
      <summary>进阶：向访客共享站主 API 配置</summary>
      <p>访客会使用站主的模型和额度，密钥保留在后端。仅在确认要分享额度时保存。</p>
      <div class="api-host-row">
      <button class="btn btn-ghost btn-sm" type="button" :disabled="!canSaveHost" @click="emit('save-host')">
        <ArchiveIcon name="upload" /> 保存为站主配置（访客可直接使用）
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

const vendorProxy = computed({
  get: () => props.vendor,
  set: value => emit('update:vendor', value),
})
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
const modelNote = computed(() => discoveredModels.value.length
  ? '列表由当前服务返回，可能包含非聊天模型；选择前核对模型的 Chat Completions 支持与价格。'
  : '参考模型核对于 2026-10-11；账号可用范围会变化，以服务商控制台和测试返回为准。')
const statusText = computed(() => testMessage.value || props.hint || '填好地址和密钥即可测试，无需先填模型。')

function connectionError(error: unknown): string {
  if (!(error instanceof ApiClientError)) return '连接测试失败，请检查地址、服务是否启动和网络后重试。'
  if (error.code === 'LOCAL_ONLY') return '连接测试仅限绘遇所在电脑直连；远程访客请联系站主配置。'
  if (error.kind === 'timeout' || error.code === 'UPSTREAM_TIMEOUT') return '连接测试超时，请检查网络或服务是否正在启动，然后重试。'
  if (error.code === 'UPSTREAM_UNAVAILABLE' || error.kind === 'network') return preset.value.local
    ? '无法连接本机服务。请先启动上方说明中的程序，确认 API 服务已开启且端口与地址一致。'
    : '无法连接服务，请检查 API 地址、网络和代理设置。'
  if (error.status === 401) return '密钥校验失败（HTTP 401），请重新复制当前服务商的 API Key。'
  if (error.status === 403) return '访问被拒绝（HTTP 403），请检查账号、地域及 API 权限。'
  if (error.status === 402) return '额度不足或需要开通 API 计费（HTTP 402），请到服务商控制台检查。'
  if (error.status === 404 || error.status === 405) return '模型目录不可用，请核对 Base URL；部分兼容服务不提供 /models，可手填官方模型 ID 后保存。'
  if (error.status === 429) return '请求过于频繁或额度受限（HTTP 429），请稍后重试并检查配额。'
  if (error.code === 'INVALID_MODEL_LIST' || error.kind === 'invalid-response') return '服务返回的内容不是模型目录，请检查地址是否填成了网页或不兼容的接口。'
  if (error.status === 400) return '配置格式无效，请核对地址和模型 ID；地址中不要携带密钥或查询参数。'
  return '连接测试失败，服务可能暂时不可用；请核对官方接入说明后重试。'
}

function selectVendor(vendor: ApiVendor) {
  if (vendor === props.vendor) return
  invalidateTest()
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
  testMessage.value = '正在连接服务并获取模型列表…'
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
      ? '服务已响应，但模型列表为空。请先下载/加载本地聊天模型，或在服务商控制台检查可用模型。'
      : missing
        ? `目录连接成功，返回 ${discoveredModels.value.length} 个模型；当前模型不在返回列表中，请重新选择或核对自定义 ID。`
        : `目录连接成功，返回 ${discoveredModels.value.length} 个模型。请选择聊天模型并保存，尚未发送生成请求。`
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
