<template>
  <details class="room-model-settings" @toggle="onToggle">
    <StudioDisclosureSummary>对话设置</StudioDisclosureSummary>
    <div v-if="visited" data-disclosure-content class="model-controls">
      <div class="provider-switch studio-segments studio-segments--compact" data-fluid-glass role="group" aria-label="对话模型来源">
        <AnimatedSelection />
        <button
          type="button"
          :class="{ active: chatProvider === 'local' }"
          :aria-pressed="chatProvider === 'local'"
          :disabled="busy"
          @click="emit('set-provider', 'local')"
        >
          已有 Ollama
        </button>
        <button
          type="button"
          :class="{ active: chatProvider === 'api' }"
          :aria-pressed="chatProvider === 'api'"
          :disabled="busy"
          @click="emit('set-provider', 'api')"
        >
          llama.cpp / API
        </button>
      </div>
      <div v-if="chatProvider === 'local'" v-content-motion:right="chatProvider" class="provider-model-controls">
        <StudioSelect
          class="model-select"
          :model-value="currentModel"
          :disabled="busy || !ollamaOnline || !models.length"
          label="选择本地聊天模型"
          :placeholder="ollamaOnline ? (models.length ? '选择本地模型' : '无可用模型') : '尚未连接聊天模型'"
          :options="models.map(m => ({ value: m.name, label: m.name + (m.parameters ? ' · ' + m.parameters : '') }))"
          @update:model-value="emit('update:currentModel', String($event))"
        />
        <button class="btn btn-ghost btn-sm" type="button" :disabled="busy || checkingLocal" @click="emit('refresh-local')">{{ checkingLocal ? '检测中…' : '重新检测' }}</button>
        <p class="local-model-help" role="status">{{ localStatusText }}<br>连接的是绘遇后端电脑上的 Ollama。请先启动 Ollama 并下载聊天模型；首次使用可到控制室准备绘遇受管 llama.cpp。</p>
      </div>
      <div v-else v-content-motion:right="chatProvider" class="provider-model-controls">
        <StudioTooltip content="允许模型请求房间工具（例如准备绘画草稿）；仅本机可用。不支持工具的模型请关闭。">
          <button class="btn btn-ghost btn-sm" type="button" :aria-pressed="companionTools" :disabled="busy" @click="emit('update:companion-tools', !companionTools)">房间工具：{{ companionTools ? '开' : '关' }}</button>
        </StudioTooltip>
        <StudioTooltip content="推理强度依服务商支持；部分模型不能关闭。Luna 启用房间工具时固定不思考。">
          <div class="thinking-group">
            <span class="thinking-title">推理</span>
            <div class="thinking-segments studio-segments studio-segments--compact" role="radiogroup" aria-label="模型推理强度">
              <AnimatedSelection />
              <button
                v-for="opt in reasoningOptions"
                :key="opt.value"
                type="button"
                role="radio"
                :aria-checked="reasoning === opt.value"
                :class="{ active: reasoning === opt.value }"
                :disabled="busy"
                @click="emit('reasoning-change', opt.value)"
              >{{ opt.label }}</button>
            </div>
          </div>
        </StudioTooltip>
        <p class="local-model-help">DeepSeek 开启房间工具时请关闭推理。Gemini 3 / 2.5 Pro 不能关闭思考，选择「关」会使用低档；其他 Gemini 2.5 使用 none 关闭。Kimi K2.6 的低 / 中 / 高均为开启思考，不区分强度。</p>
        <button
          class="api-settings-toggle"
          type="button"
          :aria-expanded="apiSettingsOpen"
          @click="emit('toggle-api-settings')"
        >
          {{ useHostConfig ? (hostApiModel || '站主 API') : (apiConfigured ? (apiModel==='huiyu-local'?'绘遇本地聊天':apiModel) : '配置 API') }}
          <ArchiveIcon name="gear" />
        </button>
      </div>
      <slot />
    </div>
  </details>
</template>

<script setup lang="ts">
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import AnimatedSelection from '@/components/visual/AnimatedSelection.vue'
import { defineAsyncComponent, ref } from 'vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'

const StudioSelect = defineAsyncComponent(() => import('@/components/ui/StudioSelect.vue'))
const visited = ref(false)
function onToggle(event: Event) { if ((event.currentTarget as HTMLDetailsElement).open) visited.value = true }

const reasoningOptions = [
  { value: 'off', label: '关' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
] as const

defineProps<{
  chatProvider: string
  busy: boolean
  ollamaOnline: boolean
  localStatusText?: string
  checkingLocal?: boolean
  models: Array<{ name: string; parameters?: string }>
  currentModel: string
  reasoning: string
  companionTools?: boolean
  apiSettingsOpen: boolean
  useHostConfig: boolean
  hostApiModel: string
  apiConfigured: boolean
  apiModel: string
}>()

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
.local-model-help { flex-basis:100%; margin:0; color:var(--text-secondary); font-size:var(--fs-label-xs); line-height:1.6; }
</style>
