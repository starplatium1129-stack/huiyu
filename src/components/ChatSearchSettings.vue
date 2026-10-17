<template>
  <details class="chat-search-settings">
    <StudioDisclosureSummary>搜索设置 · {{ settings.source.value }}</StudioDisclosureSummary>
    <form class="chat-search-body" @submit.prevent="settings.save()">
      <label class="api-field">
        <span>搜索服务</span>
        <StudioSelect v-model="settings.draftProvider.value" label="搜索服务" :options="providers" :disabled="settings.locked.value" />
      </label>
      <p class="chat-search-help">自动选择时，优先使用独立搜索密钥，再复用 DeepSeek 官方聊天密钥；未配置时使用 DuckDuckGo。</p>
      <label class="api-field" :for="id + '-key'">
        <span>DeepSeek 搜索密钥 <small>可选</small></span>
        <input :id="id + '-key'" v-model.trim="settings.draftKey.value" class="input" type="password" maxlength="1000"
          :disabled="settings.locked.value" placeholder="其他聊天模型也可单独使用 DeepSeek 搜索"
          autocomplete="off" spellcheck="false" :aria-describedby="id + '-key-help'" />
      </label>
      <p :id="id + '-key-help'" class="chat-search-help">{{ settings.desktopCredentials ? '密钥由 Windows 安全保存。' : '密钥仅用于当前页面会话。' }}DeepSeek Search 按成功且有结果的请求计费，5 元／千次；失败时会提示，不自动切换服务。</p>
      <p v-if="settings.error.value" class="chat-search-error" role="alert">{{ settings.error.value }}</p>
      <p v-else-if="settings.loading.value || settings.notice.value" class="chat-search-help" role="status">{{ settings.loading.value ? '正在读取搜索配置…' : settings.notice.value }}</p>
      <div class="chat-search-actions">
        <button class="btn btn-ghost btn-sm" type="button" :disabled="settings.locked.value" @click="settings.save(true)">清除搜索密钥</button>
        <button v-if="settings.error.value" class="btn btn-ghost btn-sm" type="button" :disabled="settings.locked.value" @click="settings.reload()">重新读取</button>
        <button class="btn btn-primary btn-sm" type="submit" :disabled="settings.locked.value">{{ settings.saving.value ? '保存中…' : '保存搜索设置' }}</button>
      </div>
    </form>
  </details>
</template>

<script setup lang="ts">
import { useId, toRefs } from 'vue'
import { useChatSearchSettings } from '@/composables/chat/useChatSearchSettings'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'

const props = defineProps<{ apiBaseUrl: string; apiKey: string; useHostConfig: boolean; hostApiBaseUrl: string; busy: boolean }>()
const settings = useChatSearchSettings(toRefs(props))
const id = useId()
const providers = [{ value: 'auto', label: '自动选择' }, { value: 'duckduckgo', label: 'DuckDuckGo' }]
</script>

<style scoped>
.chat-search-settings { min-width:0; color:var(--text-secondary); font-size:var(--fs-label-sm); }
.chat-search-settings > summary { padding:var(--s-2) 0; cursor:pointer; }
.chat-search-body { display:grid; gap:var(--s-3); padding:var(--s-2) 0; }
.chat-search-help { margin:0; line-height:1.7; }
.chat-search-error { margin:0; color:var(--danger-text); line-height:1.7; }
.chat-search-actions { display:flex; flex-wrap:wrap; gap:var(--s-2); }
.api-field small { font-weight:400; }
</style>
