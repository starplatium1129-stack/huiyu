<template>
  <details class="room-model-settings" open>
    <StudioDisclosureSummary>聊天模型</StudioDisclosureSummary>
    <div data-disclosure-content class="model-controls">
      <div class="provider-switch studio-segments studio-segments--compact" data-fluid-glass role="group" aria-label="对话模型来源">
        <AnimatedSelection />
        <button
          type="button"
          :class="{ active: chatProvider === 'local' }"
          :aria-pressed="chatProvider === 'local'"
          :disabled="busy"
          @click="emit('set-provider', 'local')"
        >
          本地 Ollama
        </button>
        <button
          type="button"
          :class="{ active: chatProvider === 'api' }"
          :aria-pressed="chatProvider === 'api'"
          :disabled="busy"
          @click="emit('set-provider', 'api')"
        >
          API 服务
        </button>
        <button v-if="isLocalHost" type="button" :class="{ active: chatProvider === 'chatgpt' }"
          :aria-pressed="chatProvider === 'chatgpt'" :disabled="busy" @click="emit('set-provider', 'chatgpt')">ChatGPT</button>
        <button v-if="isLocalHost" type="button" :class="{ active: chatProvider === 'muse' }"
          :aria-pressed="chatProvider === 'muse'" :disabled="busy" @click="emit('set-provider', 'muse')">Muse</button>
      </div>
      <div v-if="chatProvider === 'local'" v-content-motion:right="chatProvider" class="provider-model-controls">
        <AsyncPanel class="model-select" :loader="loadChatModelPicker" label="本地聊天模型选择" v-slot="{ component }"><component :is="component"
          :model-value="currentModel"
          :disabled="busy || !ollamaOnline || !models.length"
          label="选择本地聊天模型"
          :placeholder="ollamaOnline ? (models.length ? '搜索并选择模型' : '没有可用模型') : 'Ollama 尚未连接'"
          :options="models.map(m => ({ value: m.name, label: m.name + (m.parameters ? ' · ' + m.parameters : '') }))"
          @update:model-value="emit('update:currentModel', String($event))"
        /></AsyncPanel>
        <button class="btn btn-ghost btn-sm" type="button" :disabled="busy || checkingLocal" @click="emit('refresh-local')">{{ checkingLocal ? '检测中…' : '重新检测' }}</button>
        <p v-if="localStatusText" class="local-model-help" role="status">{{ localStatusText }}</p>
      </div>
      <div v-else-if="chatProvider === 'chatgpt'" v-content-motion:right="chatProvider" class="provider-model-controls chatgpt-model-controls">
        <p v-if="!isLocalHost" class="local-model-help" role="status">ChatGPT 订阅额度仅支持在运行绘遇的本机使用。</p>
        <AsyncPanel v-else-if="chatGpt" class="chatgpt-settings-loader" :loader="loadChatGptPlanSettings" label="ChatGPT 订阅额度设置" v-slot="{ component }">
          <component :is="component" :auth="chatGpt" :busy="busy" @switch-api="emit('set-provider', 'api')" />
        </AsyncPanel>
      </div>
      <div v-else-if="chatProvider === 'muse'" v-content-motion:right="chatProvider" class="provider-model-controls">
        <p class="local-model-help" role="status">{{ museStatusText }}</p>
        <p v-if="museStatus?.available && !museStatus.receiving" class="local-model-help">首次使用时，把收信说明发给 Muse，让它定时接收这个房间的提问。</p>
        <button type="button" class="btn btn-ghost btn-sm" :disabled="busy || checkingMuse" @click="emit('refresh-muse')">重新检测 Muse</button>
        <StudioCopyButton v-if="museStatus?.transport" class="btn btn-ghost btn-sm" label="复制给 Muse 的收信说明"
          :content-key="museInstructions" :action="() => copyText(museInstructions)" />
        <RouterLink v-if="isLocalHost && !museStatus?.available" class="btn btn-ghost btn-sm" to="/control#control-inference">远程连接设置</RouterLink>
      </div>
      <div v-else v-content-motion:right="chatProvider" class="provider-model-controls api-model-controls">
        <StudioTooltip anchor :content="busy ? '回复中不可修改' : apiConfigured || useHostConfig ? '修改配置' : '配置模型'">
        <button
          class="btn btn-ghost api-settings-toggle"
          type="button"
          :aria-expanded="apiSettingsOpen"
          :disabled="busy"
          @click="emit('toggle-api-settings')"
        >
          <span class="studio-control-label">{{ useHostConfig ? (hostApiModel || '站主模型') : (apiConfigured ? (apiModel==='huiyu-local'?'绘遇本地聊天':apiModel) : '配置聊天模型') }}</span>
          <ArchiveIcon name="gear" />
        </button>
        </StudioTooltip>
      </div>
      <details class="model-more-settings" @toggle="onMoreToggle">
        <StudioDisclosureSummary>更多选项</StudioDisclosureSummary>
        <div v-if="moreRevealed" class="model-more-body" data-disclosure-content>
          <template v-if="chatProvider === 'api' || chatProvider === 'chatgpt' || chatProvider === 'muse'">
            <StudioTooltip anchor :content="chatProvider === 'muse' ? '允许 Muse 把出图任务交给当前对话。设置在所有聊天窗口共享。' : '全窗口共享，可随时关闭'">
              <button class="btn btn-ghost btn-sm" type="button" :aria-pressed="companionTools" :disabled="toolsSaving" :aria-busy="toolsSaving" :data-loading="toolsSaving || undefined" @click="emit('update:companion-tools', !companionTools)">房间工具：{{ companionTools ? '开' : '关' }}</button>
            </StudioTooltip>
          </template>
          <template v-if="chatProvider === 'api' || chatProvider === 'chatgpt'">
            <ChatToolPermissions />
            <StudioTooltip :content="reasoningHint">
              <div class="thinking-group" :tabindex="reasoningHint ? 0 : undefined" :aria-label="reasoningHint ? '思考档位说明' : undefined">
                <span class="thinking-title">思考</span>
                <div class="thinking-segments studio-segments studio-segments--compact" role="radiogroup" aria-label="模型思考强度">
                  <AnimatedSelection />
                  <button v-for="opt in reasoningOptions" :key="opt.value" type="button" role="radio"
                    :aria-checked="reasoning === opt.value" :class="{ active: reasoning === opt.value }" :disabled="busy"
                    @click="emit('reasoning-change', opt.value)">{{ opt.label }}</button>
                </div>
              </div>
            </StudioTooltip>
          </template>
          <slot />
        </div>
      </details>
    </div>
  </details>
</template>

<script setup lang="ts">
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import AnimatedSelection from '@/components/visual/AnimatedSelection.vue'
import ChatToolPermissions from '@/components/ChatToolPermissions.vue'
import { useCompanionToolPermissions } from '@/composables/chat/useCompanionToolPermissions'
const { saving: toolsSaving } = useCompanionToolPermissions()
import { computed, ref } from 'vue'
import { chatApiVendorFor } from '@/config/chatApi'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import StudioCopyButton from '@/components/ui/StudioCopyButton.vue'
import { copyText } from '@/utils/clipboard'
import type { MuseChatStatus } from '@/api/chatApi'
import type { ChatGptAuthController } from '@/composables/chat/useChatGptAuth'
import type { ChatProvider } from '@/composables/chat/chatStorageTypes'
import AsyncPanel from '@/components/ui/AsyncPanel.vue'
const loadChatModelPicker = () => import('@/components/ChatModelPicker.vue')
const loadChatGptPlanSettings = () => import('@/components/ChatGptPlanSettings.vue')
const moreRevealed = ref(false)
function onMoreToggle(event: Event) {
  if ((event.currentTarget as HTMLDetailsElement).open) moreRevealed.value = true
}

const reasoningOptions = [
  { value: 'off', label: '关闭' },
  { value: 'low', label: '轻量' },
  { value: 'medium', label: '适中' },
  { value: 'high', label: '深入' },
] as const

const props = defineProps<{
  chatProvider: ChatProvider
  isLocalHost: boolean
  museStatus: MuseChatStatus | null
  museStatusText: string
  checkingMuse: boolean
  chatGpt?: ChatGptAuthController
  busy: boolean
  ollamaOnline: boolean
  localStatusText?: string
  checkingLocal?: boolean
  models: Array<{ name: string; parameters?: string }>
  currentModel: string
  reasoning: string
  companionTools?: boolean
  webSearchEnabled?: boolean
  apiSettingsOpen: boolean
  useHostConfig: boolean
  hostApiModel: string
  hostApiBaseUrl?: string
  apiConfigured: boolean
  apiModel: string
  apiBaseUrl?: string
}>()

const museInstructions = computed(() => {
  const tailscale = props.museStatus?.transport === 'tailscale'
  const inbox = tailscale ? '/desktop/pending' : '/api/muse/desktop/inbox'
  const reply = tailscale ? '/desktop/replies' : '/api/muse/desktop/reply'
  const connection = tailscale ? '使用绘遇的 Tailscale 地址和端口' : '沿用绘遇远程出图的地址和 X-Token'
  return [
    `${connection}，建立独立的绘遇桌面收信循环。`,
    `1. 持续 GET ${inbox}?wait=25（HTTP 超时 ≥40s），空收件箱立即续接（若缺少 inboxWaitSeconds 则等 2s），失败按 Retry-After 退避。`,
    `2. 按 conversationId、角色设定与 messages 回答，在 expiresAt 前用 POST ${reply} 提交 {"requestKey":"来信编号","text":"角色回复"}。`,
    `3. 用户要出图且来信 drawingAllowed 为 true 时，在上述回复里附带 drawing。它沿用远程批次的 ids 或 items 参数，省略 requestKey。文字先回复，绘遇会提交这批图并在原对话展示。每个 requestKey 只回复一次，重试沿用原编号和完整回复。`,
  ].join('\n')
})

const reasoningHint = computed(() => {
  if (props.chatProvider === 'chatgpt') return '默认关闭以沿用模型默认设置；选择轻量、适中或深入将向 Responses API 传递推理强度。'
  const vendor = chatApiVendorFor((props.useHostConfig ? props.hostApiBaseUrl : props.apiBaseUrl) || '')
  const model = props.useHostConfig ? props.hostApiModel : props.apiModel
  const tools = props.companionTools || props.webSearchEnabled
  if (vendor === 'groq') return 'Groq 当前使用模型默认推理设置。'
  if (vendor === 'deepseek' && tools) return '使用房间工具或联网检索时请关闭推理。'
  if (vendor === 'gemini' && (model.startsWith('gemini-3') || model.startsWith('gemini-2.5-pro'))) return '此模型不能关闭思考；“关闭”使用最低档。'
  if ((vendor === 'kimi' && model.startsWith('kimi-k2.6')) || (vendor === 'qwen' && model.startsWith('qwen'))) return '轻量、适中、深入均为开启思考。'
  if (vendor === 'openai' && tools && (model.startsWith('gpt-6-luna') || model.startsWith('gpt-6-sol'))) return '启用房间工具或联网检索时不使用推理。'
  return undefined
})

const emit = defineEmits<{
  (e: 'set-provider', provider: ChatProvider): void
  (e: 'update:currentModel', model: string): void
  (e: 'reasoning-change', level: 'off' | 'low' | 'medium' | 'high'): void
  (e: 'toggle-api-settings'): void
  (e: 'refresh-local'): void
  (e: 'refresh-muse'): void
  (e: 'update:companion-tools', enabled: boolean): void
}>()
</script>

<style scoped>
.provider-model-controls { display:flex; align-items:center; flex-wrap:wrap; gap:var(--s-2); min-width:0; }
.chatgpt-model-controls { width:100%; }
.chatgpt-settings-loader { width:100%; min-width:0; }
.provider-model-controls .model-select { flex:1; min-width:min(180px,100%); max-width:none; }
/* This deferred panel becomes one model field; keep its loading frame at that field's size. */
.model-select[aria-busy='true'] :deep(.async-panel-feedback) { min-height:var(--control-height); padding:var(--s-2) var(--s-3); border-radius:var(--r-md); font:500 var(--fs-body-sm)/var(--lh-label) var(--font-sans); }
.model-select[aria-busy='true'] :deep(.async-panel-loading) { width:100%; min-width:0; overflow:hidden; line-height:inherit; white-space:nowrap; }
.model-select[aria-busy='true'] :deep(.studio-orbit-spinner) { flex:none; width:22px; height:22px; }
@media (pointer:coarse) { .model-select[aria-busy='true'] :deep(.async-panel-feedback) { min-height:46px; } }
.api-model-controls > :deep(.studio-tooltip-anchor) { width:100%; min-width:0; }
.api-settings-toggle { width:100%; min-width:0; max-width:100%; justify-content:space-between; text-align:left; }
.api-settings-toggle > span { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.local-model-help { flex-basis:100%; margin:0; color:var(--text-secondary); font-size:var(--fs-label-xs); line-height:1.6; }
.model-more-settings { flex-basis:100%; color:var(--text-secondary); font-size:var(--fs-label-sm); }
.model-more-settings > summary { cursor:pointer; }
.model-more-body { display:flex; flex-wrap:wrap; align-items:center; gap:var(--s-3); padding-top:var(--s-2); }
</style>
