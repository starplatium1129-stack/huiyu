<template>
  <form class="api-settings" @submit.prevent="$emit('save')">
    <div class="api-settings-head">
      <div class="api-title-lockup">
        <span class="api-mark" aria-hidden="true">↗</span>
        <div>
          <small>MODEL GATEWAY</small>
          <strong>连接对话模型</strong>
          <span>使用 DeepSeek、OpenCode 或任意 OpenAI 兼容服务。</span>
        </div>
      </div>
      <span class="api-storage-note"><i aria-hidden="true"></i>{{ desktopCredentials ? '密钥由 Windows 安全保存' : '密钥仅用于当前页面会话' }}</span>
    </div>

    <fieldset class="api-vendor-picker">
      <legend>服务商</legend>
      <button
        v-for="option in VENDOR_OPTIONS"
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

    <div class="api-settings-grid">
      <label class="api-field">
        <span><i aria-hidden="true">01</i> API 地址</span>
        <input v-model.trim="baseUrlProxy" type="url" maxlength="500"
          placeholder="https://api.example.com/v1" autocomplete="url" required />
      </label>
      <label class="api-field">
        <span><i aria-hidden="true">02</i> 模型</span>
        <StudioSelect
          v-if="vendorProxy !== 'custom'"
          v-model="modelProxy"
          label="模型名"
          :options="modelOptions"
        />
        <template v-else>
          <input v-model.trim="modelProxy" list="chat-api-models" maxlength="200"
            aria-label="模型名"
            placeholder="填写服务商提供的模型 ID" autocomplete="off" required />
          <datalist id="chat-api-models">
            <option v-for="modelName in discoveredModels" :key="modelName" :value="modelName" />
          </datalist>
        </template>
      </label>
      <label class="api-field">
        <span><i aria-hidden="true">03</i> API Key{{ vendorProxy === 'custom' ? '（可留空）' : '' }}</span>
        <div class="api-key-field">
          <input v-model.trim="apiKeyProxy" :type="showApiKey ? 'text' : 'password'"
            maxlength="1000" placeholder="sk-…" autocomplete="off"
            :required="vendorProxy !== 'custom'" />
          <button type="button" @click="showApiKey = !showApiKey">{{ showApiKey ? '隐藏' : '显示' }}</button>
        </div>
      </label>
      <p class="api-model-note">{{ modelNote }}</p>
    </div>

    <div class="api-settings-actions">
      <span class="api-test-status" :data-state="testState" role="status">{{ statusText }}</span>
      <div class="api-settings-buttons">
          <button class="btn btn-ghost btn-sm" type="button" @click="clearPersonalKey">清除个人密钥</button>
        <button class="btn btn-ghost btn-sm" type="button"
          :disabled="testing || !canTest" @click="testConnection">
          {{ testing ? '测试中…' : '测试连接' }}
        </button>
        <button class="btn btn-primary btn-sm" type="submit">保存并使用</button>
      </div>
    </div>
    <div v-if="isLocalHost" class="api-host-row">
      <button class="btn btn-ghost btn-sm" type="button" :disabled="!canSaveHost" @click="emit('save-host')">
        <ArchiveIcon name="upload" /> 保存为站主配置（访客可直接使用）
      </button>
      <button v-if="hostConfigured" class="btn btn-ghost btn-sm" type="button" @click="emit('clear-host')">
        <ArchiveIcon name="close" /> 清除站主配置
      </button>
    </div>
    <p v-else-if="hostConfigured" class="api-host-hint">
      <ArchiveIcon name="lock" /> 站主已配置模型（{{ hostModel }}），无需密钥即可对话；密钥不会被传输或显示。
    </p>
  </form>
</template>

<script setup lang="ts">
import { getDesktopCapabilities } from '@/platform/desktop/capabilities'

import { computed, ref } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import {
  CLIPROXY_BASE_URL, CLIPROXY_API_KEY, CLIPROXY_DEFAULT_MODEL,
  DEEPSEEK_BASE_URL, DEEPSEEK_DEFAULT_MODEL,
  OPENCODE_BASE_URL, OPENCODE_DEFAULT_MODEL,
  OPENCODE_GO_BASE_URL, OPENCODE_GO_DEFAULT_MODEL,
} from '@/config/chatApi'
import { chatApi } from '@/api/chatApi'
import { createChatApiDrafts } from '@/utils/chatApiDrafts'

type ApiVendor = 'cliproxy' | 'deepseek' | 'opencode' | 'opencode-go' | 'custom'
interface ModelOption { value: string; label: string }
interface VendorOption { value: ApiVendor; label: string; note: string }

const VENDOR_OPTIONS: VendorOption[] = [
  { value: 'cliproxy', label: '本地 Gemini', note: 'CLIProxyAPI 多账号' },
  { value: 'deepseek', label: 'DeepSeek', note: '官方' },
  { value: 'opencode', label: 'OpenCode Zen', note: '免费模型' },
  { value: 'opencode-go', label: 'OpenCode Go', note: '高速通道' },
  { value: 'custom', label: '自定义', note: '兼容接口' },
]

const PRESET_MODELS: Record<Exclude<ApiVendor, 'custom'>, ModelOption[]> = {
  cliproxy: [
    { value: 'gemini-3.6-flash-high', label: 'Gemini 3.6 Flash High · 日常聊天推荐' },
    { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 · 思维推演推荐' },
    { value: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 · 强推理' },
    { value: 'gemini-3.5-flash-low', label: 'Gemini 3.5 Flash · 更省额度' },
    { value: 'gemini-3.1-pro-low', label: 'Gemini 3.1 Pro · 复杂问题' },
    { value: 'gpt-5.4-mini', label: 'GPT-5.4 Mini · Codex 账号' },
  ],
  deepseek: [
    { value: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash · 推荐' },
    { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro · 更强' },
  ],
  opencode: [
    { value: 'deepseek-v4-flash-free', label: 'DeepSeek V4 Flash Free · 免费推荐' },
    { value: 'mimo-v2.5-free', label: 'MiMo V2.5 Free · 免费' },
    { value: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash · 性价比' },
    { value: 'minimax-m2.5', label: 'MiniMax M2.5' },
    { value: 'kimi-k2.5', label: 'Kimi K2.5' },
  ],
  'opencode-go': [
    { value: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash · 推荐' },
    { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
    { value: 'kimi-k3', label: 'Kimi K3' },
    { value: 'grok-4.5', label: 'Grok 4.5' },
  ],
}

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
const desktopCredentials = Boolean(getDesktopCapabilities())
const testing = ref(false)
const testState = ref('')
const testMessage = ref('')
const discoveredModels = ref<string[]>([])
const draftStore = createChatApiDrafts(() => { testMessage.value = '旧密钥草稿暂未能安全迁移，原值已保留，请重试。' })
const vendorDrafts = draftStore.drafts

async function clearPersonalKey() {
  try {
    await draftStore.clear(props.vendor, { baseUrl: props.baseUrl, model: props.model, apiKey: props.apiKey })
    emit('update:apiKey', '')
    emit('clear-key')
  } catch { testMessage.value = '个人密钥草稿清除失败，原值已保留，请重试。' }
}

const vendorProxy = computed({
  get: () => props.vendor,
  set: value => emit('update:vendor', value),
})
const baseUrlProxy = computed({
  get: () => props.baseUrl,
  set: value => emit('update:baseUrl', value),
})
const modelProxy = computed({
  get: () => props.model,
  set: value => emit('update:model', value),
})
const apiKeyProxy = computed({
  get: () => props.apiKey,
  set: value => emit('update:apiKey', value),
})

const canTest = computed(() =>
  Boolean(props.baseUrl.trim() && props.model.trim()
    && (props.vendor === 'custom' || props.apiKey.trim()))
)
const canSaveHost = computed(() => canTest.value)
const modelOptions = computed<ModelOption[]>(() => {
  if (props.vendor === 'custom') return []
  const known = PRESET_MODELS[props.vendor]
  const extras = discoveredModels.value
    .filter(value => !known.some(option => option.value === value))
    .map(value => ({ value, label: value }))
  return known.concat(extras)
})
const modelNote = computed(() =>
  props.vendor === 'opencode' || props.vendor === 'opencode-go'
    ? 'OpenCode 模型由账号订阅决定；测试连接后会补充当前可见模型。'
    : '角色聊天默认关闭深度思考，响应更快、更省 token。'
)
const statusText = computed(() => testMessage.value || props.hint || '先测试连接，再保存配置。')

function selectVendor(vendor: ApiVendor) {
  const current = props.vendor
  // 先把当前商家的草稿存起来
  if (current !== vendor) {
    draftStore.set(current, {
      baseUrl: props.baseUrl,
      model: props.model,
      apiKey: props.apiKey,
    })
  }
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
  if (vendor === 'deepseek') {
    emit('update:baseUrl', DEEPSEEK_BASE_URL)
    emit('update:model', DEEPSEEK_DEFAULT_MODEL)
  } else if (vendor === 'cliproxy') {
    emit('update:baseUrl', CLIPROXY_BASE_URL)
    emit('update:model', CLIPROXY_DEFAULT_MODEL)
    emit('update:apiKey', CLIPROXY_API_KEY)
  } else if (vendor === 'opencode') {
    emit('update:baseUrl', OPENCODE_BASE_URL)
    emit('update:model', OPENCODE_DEFAULT_MODEL)
  } else if (vendor === 'opencode-go') {
    emit('update:baseUrl', OPENCODE_GO_BASE_URL)
    emit('update:model', OPENCODE_GO_DEFAULT_MODEL)
  }
}

async function testConnection() {
  if (!canTest.value || testing.value) return
  testing.value = true
  testState.value = 'testing'
  testMessage.value = '正在验证密钥并获取模型列表…'
  try {
    const data = await chatApi.testProvider({
        baseUrl: props.baseUrl,
        model: props.model,
        apiKey: props.apiKey,
    })
    discoveredModels.value = Array.isArray(data.models)
      ? data.models.map(String).filter(Boolean)
      : []
    testState.value = 'success'
    testMessage.value = discoveredModels.value.length
      ? `连接成功，发现 ${discoveredModels.value.length} 个模型。`
      : '连接成功；该服务没有返回模型列表。'
  } catch (error) {
    testState.value = 'error'
    testMessage.value = error instanceof Error ? error.message : '连接测试失败'
  } finally {
    testing.value = false
  }
}
</script>
