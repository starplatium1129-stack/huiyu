<template>
  <details class="room-model-settings">
    <summary>对话设置</summary>
    <div class="model-controls">
      <div class="provider-switch" role="group" aria-label="对话模型来源">
        <button
          type="button"
          :class="{ active: chatProvider === 'local' }"
          :aria-pressed="chatProvider === 'local'"
          :disabled="busy"
          @click="emit('set-provider', 'local')"
        >
          本地模型
        </button>
        <button
          type="button"
          :class="{ active: chatProvider === 'api' }"
          :aria-pressed="chatProvider === 'api'"
          :disabled="busy"
          @click="emit('set-provider', 'api')"
        >
          自定义 API
        </button>
      </div>
      <template v-if="chatProvider === 'local'">
        <StudioSelect
          class="model-select"
          :model-value="currentModel"
          :disabled="busy || !ollamaOnline || !models.length"
          label="选择本地聊天模型"
          :placeholder="ollamaOnline ? (models.length ? '选择本地模型' : '无可用模型') : '正在发现模型…'"
          :options="models.map(m => ({ value: m.name, label: m.name + (m.parameters ? ' · ' + m.parameters : '') }))"
          @update:model-value="emit('update:currentModel', String($event))"
        />
      </template>
      <template v-else>
        <StudioTooltip content="模型推理强度（像 OpenCode 一样多档；关表示不思考）">
          <div class="thinking-group">
            <span class="thinking-title">推理</span>
            <div class="thinking-segments" role="radiogroup" aria-label="模型推理强度">
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
        <button
          class="api-settings-toggle"
          type="button"
          :aria-expanded="apiSettingsOpen"
          @click="emit('toggle-api-settings')"
        >
          {{ useHostConfig ? (hostApiModel || '站主 API') : (apiConfigured ? apiModel : '配置 API') }}
          <ArchiveIcon name="gear" />
        </button>
      </template>
      <slot />
    </div>
  </details>
</template>

<script setup lang="ts">
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'

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
  models: Array<{ name: string; parameters?: string }>
  currentModel: string
  reasoning: string
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
}>()
</script>
