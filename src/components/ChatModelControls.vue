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
        <select
          class="model-select"
          :value="currentModel"
          :disabled="busy || !ollamaOnline"
          aria-label="选择本地聊天模型"
          @change="emit('update:currentModel', ($event.target as HTMLSelectElement).value)"
        >
          <option v-if="!ollamaOnline || !models.length" value="">
            {{ ollamaOnline ? '无可用模型' : '正在发现模型…' }}
          </option>
          <option v-for="m in models" :key="m.name" :value="m.name">
            {{ m.name }}{{ m.parameters ? ' · ' + m.parameters : '' }}
          </option>
        </select>
      </template>
      <template v-else>
        <label class="thinking-toggle" title="模型推理强度（像 OpenCode 一样多档；off 不思考）">
          <span>推理</span>
          <select
            class="model-select reasoning-select"
            :value="reasoning"
            :disabled="busy"
            aria-label="模型推理强度"
            @change="emit('reasoning-change', ($event.target as HTMLSelectElement).value as 'off' | 'low' | 'medium' | 'high')"
          >
            <option value="off">关</option>
            <option value="low">低</option>
            <option value="medium">中</option>
            <option value="high">高</option>
          </select>
        </label>
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
