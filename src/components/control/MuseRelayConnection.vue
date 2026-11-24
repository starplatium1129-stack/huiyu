<script setup lang="ts">
import { computed, onDeactivated, onScopeDispose, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { readMuseRelayStatus, readMuseToken, type MuseRelayStatus } from '@/api/inferenceSettingsApi'
import StudioCopyButton from '@/components/ui/StudioCopyButton.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { copyText } from '@/utils/clipboard'

const props = defineProps<{ url: string }>()
const route = useRoute()
const section = ref<HTMLElement | null>(null)
const shown = ref('')
const loading = ref(false)
const error = ref('')
let request: AbortController | undefined
const relayStatus = ref<MuseRelayStatus | null>(null)
const statusChecking = ref(false)
const statusError = ref('')
let statusRequest: AbortController | undefined
let panelObserver: MutationObserver | undefined
const statusMessage = computed(() => statusError.value || (relayStatus.value
  ? relayStatus.value.laptopOnline ? '中转可达，出图机在线' : '中转可达，出图机离线'
  : ''))
const mib = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 })
const formatMib = (bytes: number) => mib.format(bytes / 1024 ** 2)

function clearStatus() {
  statusRequest?.abort()
  statusRequest = undefined
  panelObserver?.disconnect()
  panelObserver = undefined
  statusChecking.value = false
  statusError.value = ''
  relayStatus.value = null
}
function clear() {
  clearStatus()
  request?.abort()
  request = undefined
  shown.value = ''
  loading.value = false
  error.value = ''
}
onDeactivated(clear)
onScopeDispose(clear)
watch([() => route.fullPath, () => props.url], clear, { flush: 'sync' })

async function checkStatus() {
  if (statusChecking.value) return
  const controller = new AbortController()
  statusRequest = controller
  statusChecking.value = true
  statusError.value = ''
  relayStatus.value = null

  // The setup panel keeps the native tab mounted when ComfyUI is selected.
  const panel = section.value?.closest<HTMLElement>('.control-native-options')
  if (panel) {
    panelObserver = new MutationObserver(() => {
      if (panel.style.display === 'none') clearStatus()
    })
    panelObserver.observe(panel, { attributes: true, attributeFilter: ['style'] })
  }

  try {
    const result = await readMuseRelayStatus(controller.signal)
    if (controller.signal.aborted) return
    if (result.url !== props.url) throw new Error('中转地址已更换，请刷新设置')
    relayStatus.value = result
  } catch (cause) {
    if (!controller.signal.aborted) statusError.value = cause instanceof Error ? cause.message : '检查中转状态失败'
  } finally {
    if (statusRequest === controller) {
      statusRequest = undefined
      statusChecking.value = false
      panelObserver?.disconnect()
      panelObserver = undefined
    }
  }
}

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
  <section ref="section" class="inference-connection muse-connection" aria-labelledby="muse-connection-title">
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
    <div class="muse-status">
      <button type="button" class="btn btn-ghost btn-sm" :aria-disabled="statusChecking || undefined" @click="checkStatus">
        <ArchiveIcon name="refresh" />
        {{ statusChecking ? '检查中…' : '检查中转状态' }}
      </button>
      <p class="muse-status-message" :class="{ 'muse-status-error': statusError }" role="status">{{ statusMessage }}</p>
      <dl v-if="relayStatus" class="muse-status-details">
        <dt>暂存容量</dt>
        <dd v-if="relayStatus.storage">
          已用 {{ formatMib(relayStatus.storage.usedBytes) }} MiB / {{ formatMib(relayStatus.storage.maxBytes) }} MiB
        </dd>
        <dd v-else>当前中转未提供</dd>
        <template v-if="relayStatus.storage">
          <dt>暂存原图</dt>
          <dd>已完成 {{ relayStatus.storage.readyFiles }} 张，传输中 {{ relayStatus.storage.transferringFiles }} 张</dd>
        </template>
        <dt>连接器能力</dt>
        <dd v-if="relayStatus.capabilities">
          语音{{ relayStatus.capabilities.voice ? '支持' : '未上报' }}，模型查询{{ relayStatus.capabilities.modelRead ? '支持' : '未上报' }}
        </dd>
        <dd v-else>当前中转未提供</dd>
      </dl>
    </div>
  </section>
</template>

<style scoped>
.muse-connection { display: grid; gap: var(--s-2); }
.muse-connection h3 { margin: 0; }
.muse-row { display: flex; flex-wrap: wrap; gap: var(--s-2); align-items: center; }
.muse-row input { flex: 1 1 18rem; min-width: 0; }
.muse-connection label { color: var(--text-secondary); }
.muse-status { display: grid; justify-items: start; gap: var(--s-2); margin-block-start: var(--s-2); }
.muse-status-message { margin: 0; color: var(--text-primary); }
.muse-status-message.muse-status-error { color: var(--danger-text); }
.muse-status-details {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: var(--s-1) var(--s-3);
  margin: 0;
}
.muse-status-details dt { color: var(--text-secondary); }
.muse-status-details dd { margin: 0; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
</style>
