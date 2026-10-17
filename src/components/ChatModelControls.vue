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
      </div>
      <div v-if="chatProvider === 'local'" v-content-motion:right="chatProvider" class="provider-model-controls">
        <ChatModelPicker
          class="model-select"
          :model-value="currentModel"
          :disabled="busy || !ollamaOnline || !models.length"
          label="选择本地聊天模型"
          :placeholder="ollamaOnline ? (models.length ? '搜索并选择模型' : '没有可用模型') : 'Ollama 尚未连接'"
          :options="models.map(m => ({ value: m.name, label: m.name + (m.parameters ? ' · ' + m.parameters : '') }))"
          @update:model-value="emit('update:currentModel', String($event))"
        />
        <button class="btn btn-ghost btn-sm" type="button" :disabled="busy || checkingLocal" @click="emit('refresh-local')">{{ checkingLocal ? '检测中…' : '重新检测' }}</button>
        <p v-if="localStatusText" class="local-model-help" role="status">{{ localStatusText }}</p>
      </div>
      <div v-else v-content-motion:right="chatProvider" class="provider-model-controls api-model-controls">
        <StudioTooltip anchor :content="busy ? '回复结束后可修改聊天模型' : apiConfigured || useHostConfig ? '更换模型或修改 API 配置' : '选择服务商并配置聊天模型'">
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
      <details class="model-more-settings">
        <StudioDisclosureSummary>更多选项</StudioDisclosureSummary>
        <div class="model-more-body" data-disclosure-content>
          <template v-if="chatProvider === 'api'">
            <StudioTooltip anchor :content="busy ? '回复结束后可修改房间工具' : '允许模型直接绘图、反推已发送图片和使用本地文件工具，仅本机可用'">
              <button class="btn btn-ghost btn-sm" type="button" :aria-pressed="companionTools" :disabled="busy" @click="emit('update:companion-tools', !companionTools)">房间工具：{{ companionTools ? '开' : '关' }}</button>
            </StudioTooltip>
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
import { computed, defineAsyncComponent } from 'vue'
import { chatApiVendorFor } from '@/config/chatApi'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
const ChatModelPicker = defineAsyncComponent(() => import('@/components/ChatModelPicker.vue'))


const reasoningOptions = [
  { value: 'off', label: '关闭' },
  { value: 'low', label: '轻量' },
  { value: 'medium', label: '适中' },
  { value: 'high', label: '深入' },
] as const

const props = defineProps<{
  chatProvider: string
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

const reasoningHint = computed(() => {
  const vendor = chatApiVendorFor((props.useHostConfig ? props.hostApiBaseUrl : props.apiBaseUrl) || '')
  const model = props.useHostConfig ? props.hostApiModel : props.apiModel
  const tools = props.companionTools || props.webSearchEnabled
  if (vendor === 'deepseek' && tools) return '使用房间工具或联网检索时请关闭推理。'
  if (vendor === 'gemini' && (model.startsWith('gemini-3') || model.startsWith('gemini-2.5-pro'))) return '此模型不能关闭思考；“关闭”使用最低档。'
  if ((vendor === 'kimi' && model.startsWith('kimi-k2.6')) || (vendor === 'qwen' && model.startsWith('qwen'))) return '轻量、适中、深入均为开启思考。'
  if (vendor === 'openai' && tools && (model.startsWith('gpt-6-luna') || model.startsWith('gpt-6-sol'))) return '启用房间工具或联网检索时不使用推理。'
  return undefined
})

const emit = defineEmits<{
  (e: 'set-provider', provider: 'local' | 'api'): void
  (e: 'update:currentModel', model: string): void
  (e: 'reasoning-change', level: 'off' | 'low' | 'medium' | 'high'): void
  (e: 'toggle-api-settings'): void
  (e: 'refresh-local'): void
  (e: 'update:companion-tools', enabled: boolean): void
}>()
</script>

<style scoped>
.provider-model-controls { display:flex; align-items:center; flex-wrap:wrap; gap:var(--s-2); min-width:0; }
.provider-model-controls .model-select { flex:1; min-width:min(180px,100%); max-width:none; }
.api-model-controls > :deep(.studio-tooltip-anchor) { width:100%; min-width:0; }
.api-settings-toggle { width:100%; min-width:0; max-width:100%; justify-content:space-between; text-align:left; }
.api-settings-toggle > span { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.local-model-help { flex-basis:100%; margin:0; color:var(--text-secondary); font-size:var(--fs-label-xs); line-height:1.6; }
.model-more-settings { flex-basis:100%; color:var(--text-secondary); font-size:var(--fs-label-sm); }
.model-more-settings > summary { cursor:pointer; }
.model-more-body { display:flex; flex-wrap:wrap; align-items:center; gap:var(--s-3); padding-top:var(--s-2); }
</style>
