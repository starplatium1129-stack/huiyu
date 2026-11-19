<template>
  <section class="panel-card wechat-settings" aria-labelledby="wechat-settings-title">
    <header class="wechat-header">
      <h2 id="wechat-settings-title" class="panel-heading"><ArchiveIcon name="chat" />手机聊天 · 微信</h2>
      <span v-if="status" class="field-help" role="status">{{ !status.enabled ? '已停用' : status.paired ? '已绑定' : status.keyCreated ? '待绑定' : '待生成密钥' }}</span>
    </header>
    <p v-if="!available" class="field-help">连接微信前，请在绘遇桌面版启用本机工作区。</p>
    <template v-else>
      <p class="field-help">先在同一台电脑上的 OpenClaw 安装腾讯微信插件并扫码，再用绘遇的微信桥接插件接管这个私聊。</p>
      <div class="wechat-setting">
        <label class="field-label" for="wechat-character">陪伴角色</label>
        <StudioSelect id="wechat-character" v-model="character" label="微信陪伴角色" :options="characters" />
      </div>
      <ToggleSwitch v-model="enabled" label="启用微信桥接">启用微信桥接</ToggleSwitch>
      <ToggleSwitch v-model="drawing" label="允许在微信请求本机绘图">允许在微信请求本机绘图</ToggleSwitch>
      <p v-if="drawing" class="field-help">成图后，在微信发 <code>/取图</code> 收取。</p>
      <div class="wechat-actions">
        <button class="btn btn-primary btn-sm" type="button" :disabled="busy || !status" @click="save">保存连接</button>
        <button class="btn btn-ghost btn-sm" type="button" :disabled="busy || !status?.enabled" @click="createKey">
          {{ status?.keyCreated ? '重置桥接密钥与绑定' : '生成桥接密钥' }}
        </button>
        <button class="btn btn-ghost btn-sm" type="button" :disabled="busy" @click="refresh">刷新状态</button>
      </div>
      <p v-if="feedback" class="wechat-error field-help" role="alert">{{ feedback }}</p>
      <div v-if="credentials" class="wechat-credentials">
        <p class="field-help">把桥接配置填到 OpenClaw 插件设置，替换其中的账号 ID。桥接就绪后，在微信发绑定命令，口令 15 分钟内有效。</p>
        <div class="wechat-actions">
          <StudioCopyButton class="btn btn-ghost btn-sm" label="复制桥接配置" content-key="wechat-bridge" :action="() => copyWithFeedback(bridgeConfig)" />
          <StudioCopyButton class="btn btn-ghost btn-sm" label="复制微信绑定命令" content-key="wechat-pair" :action="() => copyWithFeedback(pairCommand)" />
        </div>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import ToggleSwitch from '@/components/visual/ToggleSwitch.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import StudioCopyButton from '@/components/ui/StudioCopyButton.vue'
import { copyWithFeedback } from '@/composables/useCopyFeedback'
import { companionWeChatApi, type ChannelCharacter, type WeChatChannelStatus } from '@/api/companionChannelsApi'
import { desktopRuntimeIdentity, onDesktopRuntime } from '@/platform/desktop/runtime'

const props = defineProps<{ active: boolean }>()
const characters = [{ value: 'nene', label: '绫地宁宁' }, { value: 'natsume', label: '四季夏目' }]
const available = ref(false), enabled = ref(false), drawing = ref(false), busy = ref(false), feedback = ref('')
const character = ref<ChannelCharacter>('nene')
const status = shallowRef<WeChatChannelStatus | null>(null)
const credentials = shallowRef<WeChatChannelStatus['credentials']>(null)
const bridgeConfig = computed(() => JSON.stringify({ origin: status.value?.origin, token: credentials.value?.token, accountId: '替换为微信通道账号 ID' }, null, 2))
const pairCommand = computed(() => credentials.value ? `/绑定 ${credentials.value.pairCode}` : '')
let controller = new AbortController()
let identity = ''
let unsubscribe = () => {}

async function request(action: (signal: AbortSignal) => Promise<WeChatChannelStatus>, restore = false) {
  if (!available.value || !props.active || busy.value) return
  const { signal } = controller
  busy.value = true
  feedback.value = ''
  try {
    const value = await action(signal)
    if (signal.aborted) return
    if (restore || !status.value) {
      character.value = value.character
      enabled.value = value.enabled
      drawing.value = value.drawing
    }
    if (value.credentials || value.paired || !value.enabled) credentials.value = value.credentials
    status.value = { ...value, credentials: null }
  } catch (error) {
    if (!signal.aborted) feedback.value = error instanceof Error ? error.message : '暂时无法读取微信连接。'
  } finally {
    if (!signal.aborted) busy.value = false
  }
}
const refresh = () => request(companionWeChatApi.status)
const save = () => request(signal => companionWeChatApi.save({ enabled: enabled.value, drawing: drawing.value, character: character.value }, signal), true)
const createKey = () => request(companionWeChatApi.key)
watch(() => props.active, active => { if (active) void refresh() })
onMounted(() => {
  unsubscribe = onDesktopRuntime(runtime => {
    const next = desktopRuntimeIdentity(runtime.bootstrap)
    const ready = runtime.connection === 'ready' && Boolean(runtime.bootstrap?.runtime?.workspace)
    if (ready === available.value && next === identity) return
    controller.abort()
    controller = new AbortController()
    available.value = ready
    identity = next
    status.value = null
    credentials.value = null
    busy.value = false
    void refresh()
  })
})
onUnmounted(() => { unsubscribe(); controller.abort() })
</script>

<style scoped>
.wechat-settings,.wechat-setting,.wechat-credentials { display:grid; gap:var(--s-2); min-inline-size:0; }
.wechat-settings { gap:var(--s-3); }
.wechat-header,.wechat-actions { display:flex; flex-wrap:wrap; align-items:center; gap:var(--s-2); }
.wechat-header { justify-content:space-between; }
.wechat-header h2 { display:flex; align-items:center; gap:var(--s-2); margin:0; }
.wechat-header .archive-icon { inline-size:1em; block-size:1em; }
.wechat-settings .field-help { margin:0; overflow-wrap:anywhere; }
.wechat-settings .wechat-error { color:var(--danger-text); }
.wechat-credentials { padding:var(--s-3); border:1px solid var(--border-soft); border-radius:var(--r-md); background:var(--bg-elevated); }
</style>
