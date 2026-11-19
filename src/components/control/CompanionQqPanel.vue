<template>
  <section id="control-companion-channels" class="panel-card qq-settings" aria-labelledby="qq-settings-title">
    <header class="qq-heading">
      <h2 id="qq-settings-title" class="panel-heading"><ArchiveIcon name="chat" />手机聊天 · QQ</h2>
      <span v-if="status" class="qq-status" :data-phase="status.phase" role="status">{{ connectionLabel }}</span>
    </header>
    <p v-if="!workspace" class="field-help">连接 QQ 前，请在绘遇桌面版启用本机工作区。</p>
    <template v-else>
      <p class="field-help">在 QQ 开放平台创建机器人，再把 AppID 和 AppSecret 填到这里。绘遇在线时，可以在已绑定的私聊和群聊中使用桌宠。</p>
      <form class="qq-form" aria-labelledby="qq-settings-title" novalidate @submit.prevent="save">
        <div class="qq-fields">
          <div class="qq-field">
            <label class="field-label" for="qq-app-id">AppID</label>
            <input id="qq-app-id" ref="idField" v-model.trim="appId" class="input input-mono" inputmode="numeric" maxlength="24"
              required autocomplete="off" :aria-invalid="Boolean(idError)" :aria-describedby="idError ? 'qq-id-error' : undefined" />
            <p v-if="idError" id="qq-id-error" class="qq-error field-help">{{ idError }}</p>
          </div>
          <div class="qq-field">
            <label class="field-label" for="qq-app-secret">AppSecret</label>
            <input id="qq-app-secret" ref="secretField" v-model.trim="secret" class="input input-mono" type="password" maxlength="512"
              autocomplete="off" :required="!savedSecret" :aria-invalid="Boolean(secretError)"
              :aria-describedby="secretError ? 'qq-secret-error' : savedSecret ? 'qq-secret-help' : undefined" />
            <p v-if="secretError" id="qq-secret-error" class="qq-error field-help">{{ secretError }}</p>
            <p v-else-if="savedSecret" id="qq-secret-help" class="field-help">已保存在这台电脑，留空可继续沿用。</p>
          </div>
        </div>
        <div class="qq-field">
          <label class="field-label" for="qq-character">陪伴角色</label>
          <StudioSelect id="qq-character" v-model="character" label="QQ 陪伴角色" :options="characters" />
        </div>
        <ToggleSwitch v-model="enabled" label="启用 QQ 连接">启用 QQ 连接</ToggleSwitch>
        <fieldset class="qq-drawing-permissions">
          <legend class="field-label">允许本机绘图</legend>
          <div class="qq-actions">
            <ToggleSwitch v-model="drawing" label="允许 QQ 私聊绘图">私聊</ToggleSwitch>
            <ToggleSwitch v-model="groupDrawing" label="允许已绑定的 QQ 群绘图">已绑定的群聊</ToggleSwitch>
          </div>
        </fieldset>
        <p v-if="drawing || groupDrawing" class="field-help">绘图需要支持工具调用的聊天 API 和本机绘图模型。可在角色房间把聊天 API 保存为主机配置。</p>
        <fieldset v-if="status?.groupMuse !== undefined" class="qq-drawing-permissions qq-field">
          <legend class="field-label">交给 Muse 的 QQ 对话</legend>
          <div class="qq-actions">
            <ToggleSwitch v-if="status.privateMuse !== undefined" v-model="privateMuse">已绑定的私聊</ToggleSwitch>
            <ToggleSwitch v-model="groupMuse" aria-describedby="qq-muse-help">已绑定的群聊</ToggleSwitch>
          </div>
          <p id="qq-muse-help" class="field-help">群友可以 @ 机器人聊天、要图片，或说「帮我搜一下……」。</p>
          <template v-if="groupMuse && status.groupMuseAll !== undefined">
            <ToggleSwitch v-model="groupMuseAll" aria-describedby="qq-muse-all-help">也接收没有 @ 机器人的群消息</ToggleSwitch>
            <p id="qq-muse-all-help" class="field-help">开启后，普通群消息也会交给 Muse。群主需在 QQ 里允许机器人获取群内全部消息。</p>
          </template>
          <template v-if="(groupMuse || privateMuse) && status.museProactive !== undefined">
            <ToggleSwitch v-model="museProactive" aria-describedby="qq-muse-send-help">允许 Muse 主动发消息</ToggleSwitch>
            <p id="qq-muse-send-help" class="field-help">Muse 可以向上面启用的对话发文字或图片。接收方需在 QQ 允许机器人主动发送。</p>
          </template>
          <p v-if="status.groupMuseStatus" class="field-help" role="status">{{ museStatusLabels[status.groupMuseStatus] }}</p>
        </fieldset>
        <div class="qq-actions">
          <button class="btn btn-primary btn-sm" type="submit" :disabled="busy || !status">{{ busy ? '处理中…' : '保存连接' }}</button>
          <button class="btn btn-ghost btn-sm" type="button" :disabled="busy || !status?.enabled" @click="pair">
            {{ status?.paired ? '重新绑定私聊' : '生成私聊口令' }}
          </button>
        </div>
        <p v-if="status?.detail" class="field-help" role="status">{{ status.detail }}</p>
      </form>
      <div v-if="pairCommand" class="qq-pair">
        <p class="field-help">在手机 QQ 打开与机器人的私聊，把整条命令发给它。口令 5 分钟内有效。</p>
        <code>{{ pairCommand }}</code>
        <StudioCopyButton class="btn btn-ghost btn-sm" label="复制绑定命令" :content-key="pairCommand" :action="() => copyWithFeedback(pairCommand)" />
      </div>
      <section v-if="status?.configured" class="qq-groups" aria-labelledby="qq-groups-title">
        <header class="qq-heading">
          <h3 id="qq-groups-title" ref="groupHeading" tabindex="-1">QQ 群聊</h3>
          <span class="qq-status" role="status">{{ status.groups.length ? `已绑定 ${status.groups.length} 个群` : '未绑定群' }}</span>
        </header>
        <p class="field-help">先把有群聊权限的机器人加进目标群。绑定后，群成员 @ 机器人就能互动。</p>
        <form class="qq-group-form" aria-labelledby="qq-groups-title" @submit.prevent="pairGroup">
          <div class="qq-field">
            <label class="field-label" for="qq-group-name">群备注（可选）</label>
            <input id="qq-group-name" v-model.trim="groupLabel" name="label" class="input" maxlength="40" />
          </div>
          <button class="btn btn-ghost btn-sm" type="submit" :disabled="busy || !status.enabled">生成群口令</button>
        </form>
        <div v-if="groupPairCommand" class="qq-pair">
          <p class="field-help">在目标群里先 @ 机器人，再发送这条命令。口令 5 分钟内有效。</p>
          <code>{{ groupPairCommand }}</code>
          <StudioCopyButton class="btn btn-ghost btn-sm" label="复制群绑定命令" :content-key="groupPairCommand" :action="() => copyWithFeedback(groupPairCommand)" />
        </div>
        <ul v-if="status.groups.length" class="qq-group-list" aria-label="已绑定的 QQ 群">
          <li v-for="group in status.groups" :key="group.id">
            <span>{{ group.label }}</span>
            <button class="btn btn-ghost btn-sm" type="button" :aria-label="`解除绑定：${group.label}`" :disabled="busy" @click="removeGroup(group.id)">解除绑定</button>
          </li>
        </ul>
      </section>
      <p v-if="feedback" class="qq-error field-help" role="alert">{{ feedback }}</p>
      <div class="qq-actions">
        <a class="btn btn-ghost btn-sm" href="https://q.qq.com/qqbot/" target="_blank" rel="noopener noreferrer">打开 QQ 机器人开放平台 <ArchiveIcon name="chevron-down" /></a>
        <button v-if="!status && feedback" class="btn btn-ghost btn-sm" type="button" @click="refresh">重新读取</button>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import ToggleSwitch from '@/components/visual/ToggleSwitch.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import StudioCopyButton from '@/components/ui/StudioCopyButton.vue'
import { copyWithFeedback } from '@/composables/useCopyFeedback'
import { companionQqApi, type ChannelCharacter, type QqChannelStatus } from '@/api/companionChannelsApi'
import { desktopRuntimeIdentity, onDesktopRuntime } from '@/platform/desktop/runtime'

const props = defineProps<{ active: boolean }>()
const characters = [{ value: 'nene', label: '绫地宁宁' }, { value: 'natsume', label: '四季夏目' }]
const appId = ref(''), secret = ref(''), character = ref<ChannelCharacter>('nene')
const enabled = ref(false), drawing = ref(false), attempted = ref(false), busy = ref(false), feedback = ref('')
const groupDrawing = ref(false), groupLabel = ref('')
const groupMuse = ref(false)
const privateMuse = ref(false), groupMuseAll = ref(false), museProactive = ref(false)
const museStatusLabels = {
  remoteDisabled: '远程接口未启动，请检查原生绘图的「允许连接」。',
  waiting: '正在等待 Muse 通过远程接口收信。最近 90 秒没有收信请求。',
  receiving: '最近 90 秒收到过 Muse 的收信请求。',
  vmConfigured: '已指定 Muse 虚拟机。收到提问后，绘遇会投递问题并查询答复。',
  vmUnavailable: '虚拟机接口暂未就绪。请检查接收端口和回复格式，绘遇会在消息过期前重试。',
  vmConfigError: '虚拟机配置无效。请检查 muse-qq-vm.json，然后重新保存 QQ 连接。',
}
const groupHeading = shallowRef<HTMLElement | null>(null)
const workspace = ref(false), status = shallowRef<QqChannelStatus | null>(null)
const idField = shallowRef<HTMLInputElement | null>(null), secretField = shallowRef<HTMLInputElement | null>(null)
const savedSecret = computed(() => Boolean(status.value?.configured && status.value.appId === appId.value))
const idError = computed(() => attempted.value && !/^\d{1,24}$/.test(appId.value) ? '请输入 QQ 开放平台里的数字 AppID。' : '')
const secretError = computed(() => attempted.value && (!savedSecret.value || secret.value) && !/^[\x21-\x7E]{8,512}$/.test(secret.value) ? '请检查 AppSecret 是否复制完整。' : '')
const pairCommand = computed(() => status.value?.pairCode ? `/绑定 ${status.value.pairCode}` : '')
const groupPairCommand = computed(() => status.value?.groupPairCode ? `/绑定群 ${status.value.groupPairCode}` : '')
const connectionLabel = computed(() => {
  const value = status.value
  if (!value?.configured) return '未配置'
  if (value.phase === 'online') return value.paired || value.groups.length ? '已连接 · 已绑定' : '已连接 · 待绑定'
  return { connecting: '正在连接', disabled: '已停用', error: '连接异常' }[value.phase]
})
let controller = new AbortController()
let timer: ReturnType<typeof setTimeout> | undefined
let refreshing = false
let mutation = 0
let identity = ''
let unsubscribe = () => {}

function apply(value: QqChannelStatus, restoreFields = false) {
  status.value = value
  if (!restoreFields) return
  appId.value = value.appId || ''
  character.value = value.character
  drawing.value = value.drawing
  groupDrawing.value = value.groupDrawing
  groupMuse.value = value.groupMuse ?? false
  privateMuse.value = value.privateMuse ?? false
  groupMuseAll.value = value.groupMuseAll ?? false
  museProactive.value = value.museProactive ?? false
  enabled.value = value.enabled || !value.configured
}

function schedule() {
  clearTimeout(timer)
  if (props.active && workspace.value && status.value?.enabled) timer = setTimeout(() => { void refresh() }, 3500)
}

async function refresh() {
  if (!workspace.value || !props.active || refreshing || busy.value) { schedule(); return }
  refreshing = true
  const revision = mutation
  const { signal } = controller
  try {
    const value = await companionQqApi.status(signal)
    if (!signal.aborted && !busy.value && revision === mutation) {
      if (!status.value) feedback.value = ''
      apply(value, !status.value)
    }
  } catch (error) {
    if (!signal.aborted && !status.value) feedback.value = error instanceof Error ? error.message : '无法读取 QQ 连接设置。'
  } finally {
    if (!signal.aborted) { refreshing = false; schedule() }
  }
}

async function change(action: (signal: AbortSignal) => Promise<QqChannelStatus>, restoreFields = false) {
  if (busy.value || !workspace.value) return
  const { signal } = controller
  mutation++
  busy.value = true
  feedback.value = ''
  try {
    const result = await action(signal)
    if (!signal.aborted) {
      apply(result, restoreFields)
      if (restoreFields) { secret.value = ''; attempted.value = false }
    }
  } catch (error) {
    if (!signal.aborted) feedback.value = error instanceof Error ? error.message : '连接设置暂时无法保存。'
  } finally {
    if (!signal.aborted) { busy.value = false; schedule() }
  }
}

async function save() {
  attempted.value = true
  if (idError.value || secretError.value) {
    await nextTick()
    const field = idError.value ? idField.value : secretField.value
    field?.focus()
    return
  }
  await change(signal => companionQqApi.save({ appId: appId.value, secret: secret.value || undefined, character: character.value,
    enabled: enabled.value, drawing: drawing.value, groupDrawing: groupDrawing.value,
    groupMuse: status.value?.groupMuse === undefined ? undefined : groupMuse.value,
    privateMuse: status.value?.privateMuse === undefined ? undefined : privateMuse.value,
    groupMuseAll: status.value?.groupMuseAll === undefined ? undefined : groupMuseAll.value,
    museProactive: status.value?.museProactive === undefined ? undefined : museProactive.value }, signal), true)
}

function pair() { void change(companionQqApi.pair) }
function pairGroup() { void change(signal => companionQqApi.pairGroup(groupLabel.value, signal)) }

async function removeGroup(id: string) {
  const previous = document.activeElement
  await change(signal => companionQqApi.removeGroup(id, signal))
  if (!status.value || status.value.groups.some(group => group.id === id)) return
  await nextTick()
  if (document.activeElement === document.body || document.activeElement === previous) groupHeading.value?.focus({ preventScroll: true })
}

watch(() => props.active, active => { if (active) void refresh(); else clearTimeout(timer) })
onMounted(() => {
  unsubscribe = onDesktopRuntime(runtime => {
    const next = desktopRuntimeIdentity(runtime.bootstrap)
    const available = runtime.connection === 'ready' && Boolean(runtime.bootstrap?.runtime?.workspace)
    if (next === identity && available === workspace.value) return
    controller.abort()
    controller = new AbortController()
    refreshing = false
    busy.value = false
    secret.value = ''
    feedback.value = ''
    groupLabel.value = ''
    status.value = null
    workspace.value = available
    identity = next
    void refresh()
  })
})
onUnmounted(() => { unsubscribe(); controller.abort(); clearTimeout(timer) })
</script>

<style scoped>
.qq-settings,.qq-form,.qq-field,.qq-pair,.qq-groups { display:grid; gap:var(--s-2); min-inline-size:0; }
.qq-settings { gap:var(--s-3); }
.qq-heading,.qq-actions { display:flex; align-items:center; flex-wrap:wrap; gap:var(--s-2); }
.qq-heading { justify-content:space-between; }
.qq-heading h2 { margin:0; display:flex; align-items:center; gap:var(--s-2); }
.qq-actions .archive-icon,.qq-heading .archive-icon { inline-size:1em; block-size:1em; }
.qq-status { color:var(--text-secondary); font-size:var(--fs-label); }
.qq-fields { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,14rem),1fr)); gap:var(--s-3); }
.qq-form { align-items:start; }
.qq-field { align-content:start; }
.qq-field .input { inline-size:100%; }
.qq-field .input[aria-invalid='true'] { border-color:var(--danger-text); }
.qq-settings .qq-error { color:var(--danger-text); }
.qq-settings .field-help { margin:0; overflow-wrap:anywhere; }
.qq-pair { justify-items:start; padding:var(--s-3); border:1px solid var(--border-soft); border-radius:var(--r-md); background:var(--bg-elevated); }
.qq-pair code { color:var(--text-primary); overflow-wrap:anywhere; }
.qq-drawing-permissions,.qq-group-list { min-inline-size:0; padding:0; margin:0; border:0; }
.qq-groups { padding-block-start:var(--s-3); border-block-start:1px solid var(--border-soft); }
.qq-groups h3 { margin:0; font-size:var(--fs-body); }
.qq-group-form { display:flex; align-items:end; flex-wrap:wrap; gap:var(--s-2); }
.qq-group-form .qq-field { flex:1 1 12rem; }
.qq-group-list { display:grid; gap:var(--s-1); list-style:none; }
.qq-group-list li { display:flex; justify-content:space-between; align-items:center; gap:var(--s-2); padding-block:var(--s-1); border-block-end:1px solid var(--border-soft); }
.qq-group-list li span { min-inline-size:0; overflow-wrap:anywhere; }
.qq-group-list li button { flex-shrink:0; }
</style>
