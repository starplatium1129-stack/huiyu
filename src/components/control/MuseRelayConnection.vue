<script setup lang="ts">
import { onDeactivated, onScopeDispose, ref } from 'vue'
import { readMuseToken } from '@/api/inferenceSettingsApi'
import StudioCopyButton from '@/components/ui/StudioCopyButton.vue'
import { copyText } from '@/utils/clipboard'

const props = defineProps<{ url: string }>()
const shown = ref('')
const loading = ref(false)
const error = ref('')
let request: AbortController | undefined
function clear() {
  request?.abort()
  request = undefined
  shown.value = ''
  loading.value = false
  error.value = ''
}
onDeactivated(clear)
onScopeDispose(clear)
async function read() {
  if (shown.value) return shown.value
  if (loading.value) return ''
  const controller = new AbortController()
  request = controller
  loading.value = true
  error.value = ''
  try {
    const result = await readMuseToken(controller.signal)
    if (result.url !== props.url) throw new Error('中转地址已更换，请刷新设置')
    return controller.signal.aborted ? '' : result.token
  } catch (cause) {
    if (!controller.signal.aborted) error.value = cause instanceof Error ? cause.message : '读取密钥失败'
    return ''
  } finally { if (request === controller) { request = undefined; loading.value = false } }
}
async function toggle() { shown.value = shown.value ? '' : await read() }
async function copyKey() { const key = await read(); return !!key && copyText(key) }
</script>

<template>
  <section class="inference-connection muse-connection" aria-labelledby="muse-connection-title">
    <h3 id="muse-connection-title">Muse 远程出图</h3>
    <label for="muse-relay-url">中转地址</label>
    <div class="muse-row">
      <input id="muse-relay-url" class="input input-mono" type="url" :value="url" readonly />
      <StudioCopyButton class="btn btn-ghost btn-sm" label="复制地址" :content-key="url" :action="() => copyText(url)" />
    </div>
    <label for="muse-relay-token">X-Token</label>
    <div class="muse-row">
      <input id="muse-relay-token" class="input input-mono" :type="shown ? 'text' : 'password'" :value="shown" placeholder="密钥已隐藏" autocomplete="off" spellcheck="false" readonly />
      <button type="button" class="btn btn-quiet btn-sm" :aria-label="shown ? '隐藏密钥 X-Token' : '显示密钥 X-Token'" :disabled="loading" @click="toggle">{{ loading ? '读取中…' : shown ? '隐藏密钥' : '显示密钥' }}</button>
      <StudioCopyButton class="btn btn-ghost btn-sm" label="复制 X-Token" :content-key="url" :disabled="loading" :action="copyKey" />
    </div>
    <p v-if="error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.muse-connection { display: grid; gap: var(--s-2); }
.muse-connection h3 { margin: 0; }
.muse-row { display: flex; flex-wrap: wrap; gap: var(--s-2); align-items: center; }
.muse-row input { flex: 1 1 18rem; min-width: 0; }
.muse-connection label { color: var(--text-secondary); }
</style>
