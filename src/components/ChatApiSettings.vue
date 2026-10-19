<template>
  <form class="api-settings" @submit.prevent="canSave && emit('save')">
    <div class="api-settings-head">
      <div class="api-title-lockup">
        <span class="api-mark" aria-hidden="true"><ArchiveIcon name="chat" /></span>
        <div><strong>对话模型</strong></div>
      </div>
      <span class="api-storage-note" role="note" :aria-label="desktopCredentials ? '密钥由 Windows 安全保存' : '密钥仅用于当前页面会话'">
        <ArchiveIcon name="lock" aria-hidden="true" />{{ desktopCredentials ? '本机保存' : '仅本次会话' }}
      </span>
    </div>

    <div class="api-provider-row">
      <label class="api-field">
        <span>服务商</span>
        <StudioSelect :model-value="vendor" label="服务商" :groups="providerGroups" :disabled="locked"
          @update:model-value="selectVendor($event as ApiVendor)" />
      </label>
      <div v-if="preset.keyUrl || preset.docsUrl" class="api-provider-help api-help-links">
        <a v-if="preset.keyUrl" :href="preset.keyUrl" target="_blank" rel="noopener noreferrer" aria-label="获取密钥，在新窗口打开">获取密钥</a>
        <a v-if="preset.docsUrl" :href="preset.docsUrl" target="_blank" rel="noopener noreferrer" aria-label="官方说明，在新窗口打开">官方说明</a>
      </div>
    </div>

    <p class="api-provider-description">{{ preset.help }}</p>

    <label v-if="needsKey" class="api-field">
      <span>API 密钥</span>
      <div class="api-key-field">
        <input v-model.trim="apiKeyProxy" class="input" :type="showApiKey ? 'text' : 'password'" :disabled="locked"
          maxlength="1000" placeholder="粘贴服务商的 API Key" autocomplete="off" required aria-label="API 密钥" spellcheck="false" />
        <button class="btn btn-quiet btn-sm" type="button" :disabled="locked" :aria-label="showApiKey ? '隐藏密钥' : '显示密钥'" :aria-pressed="showApiKey" @click="showApiKey = !showApiKey">{{ showApiKey ? '隐藏' : '显示' }}</button>
      </div>
    </label>

    <StudioCheckbox v-if="vendor === 'openrouter'" v-model:checked="freeModelsOnly" label="只选免费模型" :disabled="locked">只选免费模型</StudioCheckbox>

    <div class="api-model-row">
      <div class="api-field">
        <span>聊天模型</span>
        <ChatModelPicker v-model="modelProxy" :options="modelOptions" label="聊天模型"
          :placeholder="filteringFreeModels ? '搜索免费模型' : '搜索或输入模型名'" :allow-custom="!filteringFreeModels" :disabled="locked" />
      </div>
      <StudioTooltip :content="fetchingModels ? undefined : connectionHint || undefined" :anchor="!canFetchModels && !fetchingModels">
        <button class="btn btn-ghost api-fetch-models" type="button" :disabled="!fetchingModels && !canFetchModels"
          @click="fetchingModels ? cancelFetch() : fetchModels()">{{ fetchingModels ? '取消获取' : '获取模型' }}</button>
      </StudioTooltip>
    </div>

    <details class="api-connection-settings" :open="connectionOpen" @toggle="onConnectionToggle">
      <StudioDisclosureSummary>连接设置</StudioDisclosureSummary>
      <div class="api-connection-body" data-disclosure-content>
        <label class="api-field">
          <span>API 地址</span>
          <input v-model.trim="baseUrlProxy" class="input" type="url" maxlength="500" :disabled="locked"
            placeholder="https://api.example.com/v1" autocomplete="url" required :aria-invalid="Boolean(addressError)"
            :aria-describedby="addressError ? id + '-address-help' : undefined" />
          <small v-if="addressError" :id="id + '-address-help'" class="api-address-error">{{ addressError }}</small>
        </label>
        <label v-if="!needsKey" class="api-field">
          <span>访问密钥 <small>可选</small></span>
          <div class="api-key-field">
            <input v-model.trim="apiKeyProxy" class="input" :type="showApiKey ? 'text' : 'password'" :disabled="locked"
              maxlength="1000" placeholder="服务未开启认证时留空" autocomplete="off" aria-label="访问密钥" spellcheck="false" />
            <button class="btn btn-quiet btn-sm" type="button" :disabled="locked" :aria-label="showApiKey ? '隐藏密钥' : '显示密钥'" :aria-pressed="showApiKey" @click="showApiKey = !showApiKey">{{ showApiKey ? '隐藏' : '显示' }}</button>
          </div>
        </label>
        <div class="api-connection-actions">
          <button v-if="preset.baseUrl && baseUrl !== preset.baseUrl" class="btn btn-ghost btn-sm" type="button" :disabled="locked" @click="baseUrlProxy = preset.baseUrl">恢复默认地址</button>
          <button class="btn btn-ghost btn-sm" type="button" :disabled="locked" @click="clearPersonalKey">{{ clearingKey ? '清除中…' : '清除密钥' }}</button>
        </div>
      </div>
    </details>

    <div class="api-settings-actions">
      <p v-if="hint" class="api-test-status" role="status">{{ hint }}</p>
      <p v-if="statusText" class="api-test-status" :data-state="state" role="status">{{ statusText }}</p>
      <div class="api-settings-buttons">
        <p v-if="!preset.local" class="api-model-note">{{ usageNote }}</p>
        <StudioTooltip :content="saveHint || undefined" :anchor="!canSave">
          <button class="btn btn-primary" type="submit" :disabled="!canSave">保存并使用</button>
        </StudioTooltip>
      </div>
    </div>
    <details v-if="isLocalHost" class="api-host-advanced">
      <StudioDisclosureSummary>共享给访客</StudioDisclosureSummary>
      <div data-disclosure-content>
        <p>访客将使用你的模型与额度，密钥保留在后端。</p>
        <div class="api-connection-actions">
          <button class="btn btn-ghost btn-sm" type="button" :disabled="!canSave" @click="emit('save-host')"><ArchiveIcon name="upload" />共享当前配置</button>
          <button v-if="hostConfigured" class="btn btn-ghost btn-sm" type="button" :disabled="locked" @click="emit('clear-host')"><ArchiveIcon name="close" />停止共享</button>
        </div>
      </div>
    </details>
    <p v-else-if="hostConfigured" class="api-host-hint"><ArchiveIcon name="lock" />站主模型：{{ hostModel }}，可直接对话。</p>
  </form>
</template>

<script setup lang="ts">
import { onUnmounted, ref, useId, watch } from 'vue'
import { getDesktopCapabilities } from '@/platform/desktop/capabilities'
import { registerMaintenanceParticipant } from '@/platform/maintenanceParticipants'
import { useChatApiEditor, type ChatApiEditorProps } from '../composables/chat/useChatApiEditor'
import type { ApiVendor } from '@/config/chatApi'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import ChatModelPicker from '@/components/ChatModelPicker.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import StudioCheckbox from '@/components/ui/StudioCheckbox.vue'

const props = defineProps<ChatApiEditorProps & { isLocalHost?: boolean; hostConfigured?: boolean; hostModel?: string }>()
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
const id = useId()
const showApiKey = ref(false)
const desktopCredentials = Boolean(getDesktopCapabilities())
onUnmounted(registerMaintenanceParticipant(() => { throw new Error('OPEN_API_SETTINGS') }))
watch(() => props.vendor, () => { showApiKey.value = false })
const { preset, needsKey, providerGroups, addressError, baseUrlProxy, modelProxy, apiKeyProxy, locked, connectionOpen,
  fetchingModels, clearingKey, state, statusText, modelOptions, freeModelsOnly, filteringFreeModels, usageNote, connectionHint, saveHint, canFetchModels, canSave,
  selectVendor, fetchModels, cancelFetch, clearPersonalKey } = useChatApiEditor(props, emit)
function onConnectionToggle(event: Event) { connectionOpen.value = (event.currentTarget as HTMLDetailsElement).open }
</script>

<style scoped>
.api-provider-row { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:var(--s-3); align-items:end; }
.api-provider-help { min-height:var(--control-height); align-items:center; }
.api-provider-description { margin:0; color:var(--text-secondary); font-size:var(--fs-label-sm); line-height:1.6; }
.api-provider-help, .api-host-advanced { color:var(--text-secondary); font-size:var(--fs-label-sm); line-height:1.6; }
.api-help-links { display:flex; flex-wrap:wrap; gap:var(--s-2) var(--s-4); }
.api-help-links a { color:var(--character-ink, var(--accent)); text-decoration:underline; text-underline-offset:3px; }
.api-model-row { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:var(--s-3); align-items:end; }
.api-model-row > :last-child { align-self:end; }
.api-fetch-models { white-space:nowrap; }
.api-connection-settings { min-width:0; color:var(--text-secondary); font-size:var(--fs-label-sm); }
.api-connection-settings > summary, .api-host-advanced > summary { cursor:pointer; padding:var(--s-2) 0; }
.api-connection-body { display:grid; gap:var(--s-3); padding-top:var(--s-2); }
.api-connection-actions { display:flex; flex-wrap:wrap; gap:var(--s-2); }
.api-settings-buttons { align-items:center; }
.api-settings-buttons .api-model-note { margin:0 auto 0 0; }
.api-host-advanced p { margin:var(--s-2) 0; }
.api-test-status[data-state="warning"] { color:var(--warning-text); }
.api-field .api-address-error { color:var(--danger-text); }
.api-field > span small { font-weight:400; }
@media (max-width:600px) { .api-provider-row { grid-template-columns:1fr; gap:var(--s-2); } .api-provider-help { min-height:32px; } }
</style>
