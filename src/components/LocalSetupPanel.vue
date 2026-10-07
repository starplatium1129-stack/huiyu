<template>
  <section id="control-setup" class="panel-card local-setup" aria-labelledby="local-setup-title">
    <div class="setup-heading">
      <div><span class="panel-kicker">本机起步</span><h2 id="local-setup-title" class="panel-heading">首次配置</h2></div>
      <div v-if="isLocal" class="setup-actions">
        <button class="btn btn-ghost btn-sm" type="button" :disabled="loading" @click="refresh">
          <ArchiveIcon name="refresh" />{{ loading ? '检查中…' : '重新检查' }}
        </button>
        <button v-if="loading" class="btn btn-ghost btn-sm" type="button" @click="cancelCheck">取消检查</button>
      </div>
    </div>
    <p v-if="!isLocal" class="setup-note">请在运行绘遇的本机打开控制室；远程访问不会读取工作区或设备信息。</p>
    <template v-else>
      <p class="setup-scope">绘图首选 MiaoMiao 1.6，Base 为更自由的风格候选。绘遇可以准备环境、模型与作者亲训的角色 LoRA；聊天按硬件推荐 llama.cpp 或 API。</p>
      <div class="setup-result" :data-state="basicComplete ? 'checked' : 'pending'" role="status" aria-live="polite">
        <ArchiveIcon :name="basicComplete ? 'success' : 'info'" /><strong>{{ summary }}</strong>
      </div>
      <p v-if="error" class="setup-error" role="alert">{{ error }}</p>
      <div v-if="snapshot" class="setup-overview" aria-label="基础检查摘要">
        <span>ComfyUI 入口：{{ fileLabel(snapshot.comfy.installation) }}</span>
        <span>服务：{{ connectionLabel }}</span>
        <span>推荐文件：{{ presentRecommended }} / {{ recommendedModels.length }} 大小相符</span>
        <span>节点：{{ nodeLabel }}</span>
      </div>
      <p class="setup-next"><strong>下一步</strong> {{ nextStep }}</p>
      <div class="setup-actions">
        <button v-if="desktop" ref="workspaceButton" class="btn btn-ghost btn-sm" type="button" :disabled="workspaceLoading || workspaceSaving" @click="openWorkspace">
          <ArchiveIcon name="gear" />{{ workspaceLoading ? '读取目录中…' : '选择 AI 工作区' }}
        </button>
        <RouterLink v-if="basicComplete" class="btn btn-ghost btn-sm" to="/prompt-builder"><ArchiveIcon name="spark" />前往工作台验证</RouterLink>
      </div>
      <p v-if="workspaceNotice" class="setup-note" role="status">{{ workspaceNotice }}</p>
      <button v-if="workspacePending && desktop?.restartForSetup" class="btn btn-primary btn-sm" type="button" @click="restartForSetup">重启绘遇并继续配置</button>
      <p v-if="downloadNotice" class="setup-note" role="status">{{ downloadNotice }}</p>
      <p v-if="workspaceError && !workspaceOpen" class="setup-error" role="alert">{{ workspaceError }}</p>
      <LocalSetupAutomation v-if="snapshot" :snapshot="snapshot" :workspace-blocked="workspacePending || workspaceUnconfirmed" @refresh="refresh" @download-result="recordDownload" @model-selected="selectSetupModel" />
      <LocalSetupPreparation v-if="snapshot" :snapshot="snapshot" :desktop="!!desktop" :workspace-pending="workspacePending" :workspace-unconfirmed="workspaceUnconfirmed" @workspace="openWorkspace" @refresh="refresh" @verification-result="recordVerification" @download-result="recordDownload" />
      <details class="setup-details">
        <StudioDisclosureSummary>查看路径与详细检查<span v-if="snapshot">{{ checkedAtLabel }}</span></StudioDisclosureSummary>
        <div data-disclosure-content class="setup-detail-body">
          <div class="setup-detail">
            <h3>1. AI 工作区与 ComfyUI</h3>
            <template v-if="snapshot">
              <p>当前运行时工作区：{{ fileLabel(snapshot.workspace.state) }}</p><code>{{ snapshot.workspace.path }}</code>
              <p>ComfyUI 目录：{{ fileLabel(snapshot.comfy.installation) }}</p><code>{{ snapshot.comfy.path }}</code>
              <p>AI 工作区用于保存模型与受管环境。手动管理已有 ComfyUI 时选择其父目录；受管 Portable 不需要改环境目录。</p>
              <p v-if="snapshot.comfy.layout === 'portable'">已识别 Portable 的独立 Python 布局，可使用绘遇受管启动。</p>
              <p v-else-if="snapshot.comfy.layout === 'external-venv'">已识别 .venv 布局，可能由 Desktop 或其他环境管理器维护。请由原入口启动后连接，不交给绘遇受控启动。</p>
              <p v-else-if="snapshot.comfy.layout === 'venv'">已识别 venv 布局；检测到目录不代表 Python、PyTorch 或驱动已可运行。</p>
              <p v-else>未识别 venv / 便携版布局；Conda 等环境请沿用自己的启动入口，不据此判定服务不可用。</p>
              <p>检查的服务地址：</p><code>{{ snapshot.comfy.host }}</code>
              <p>服务在线不保证使用上面的本地目录；请核对手动启动的实例及其模型目录。</p>
            </template>
            <p v-else>完成一次检查后显示当前运行时的目录与连接状态。</p>
            <p v-if="!desktop">浏览器模式：在启动网关的环境中设置 AI_WORKSPACE_ROOT 为 AI 工作区父目录，再重启网关；不是选择 ComfyUI 目录本身。</p>
            <div class="setup-links"><a href="https://docs.comfy.org/installation/manual_install" target="_blank" rel="noopener noreferrer">ComfyUI 官方安装说明</a><a href="https://docs.comfy.org/installation/comfyui_portable_windows" target="_blank" rel="noopener noreferrer">Windows 便携版说明</a></div>
          </div>
          <div class="setup-detail">
            <h3>2. 基础验证推荐文件</h3>
            <ul v-if="snapshot" class="setup-models">
              <li v-for="model in recommendedModels" :key="model.id"><div><strong>{{ model.label }}</strong><span :data-state="model.state">{{ fileLabel(model.state) }}{{ model.bytes === null ? '' : ' · ' + formatBytes(model.bytes) }}</span></div><code>{{ model.path }}</code></li>
            </ul>
            <p>文件存在和文件大小不代表 SHA-256、完整性或模型加载验证。请按发布者说明核对来源、许可与文件校验值。</p>
            <a href="https://huggingface.co/circlestone-labs/Anima/tree/f973fc41ec7545364ac9776c2440285f43ff2a30/split_files" target="_blank" rel="noopener noreferrer">Anima 作者固定版本文件目录</a>
            <template v-if="otherModels.length">
              <h4>其他已支持的 Anima 底模</h4>
              <ul class="setup-models"><li v-for="model in otherModels" :key="model.id"><div><strong>{{ model.label }}</strong><span :data-state="model.state">{{ fileLabel(model.state) }}</span></div><code>{{ model.path }}</code></li></ul>
              <p>缺少推荐组合不代表现有配置不可用，可继续按自己的底模与工作流验证。Anima Base 的无 LoRA 路径当前未在绘遇工作流中声明。</p>
            </template>
          </div>
          <div class="setup-detail">
            <h3>3. 基础工作流节点</h3>
            <template v-if="snapshot">
              <p>{{ nodeLabel }}。这里只查询服务的节点注册信息，不执行工作流，不代表真实出图通过。</p>
              <p v-if="snapshot.nodes.required.length">所需注册名：</p><code v-if="snapshot.nodes.required.length">{{ snapshot.nodes.required.join(' · ') }}</code>
              <p v-if="snapshot.nodes.missing.length" class="setup-warning">缺少注册名：{{ snapshot.nodes.missing.join(' · ') }}</p>
            </template>
            <p>当前基础工作流也需要 KJNodes 的 ImageSharpenKJ。按作者说明准备后手动重启 ComfyUI，再重新检查。</p>
            <a href="https://github.com/kijai/ComfyUI-KJNodes" target="_blank" rel="noopener noreferrer">KJNodes 作者仓库</a>
          </div>
          <div class="setup-detail">
            <h3>4. 硬件与验证边界</h3>
            <ul v-if="snapshot?.hardware.state === 'reported' && snapshot.hardware.devices.length" class="setup-devices">
              <li v-for="(device, index) in snapshot.hardware.devices" :key="index">{{ device.name }} · {{ device.type }} · 设备上报内存 {{ device.vramBytes === null ? '未知' : formatBytes(device.vramBytes) }}</li>
            </ul>
            <p v-else>设备报告未知。</p>
            <p>系统内存上报总量：{{ snapshot?.hardware.state === 'reported' && snapshot.hardware.ramBytes !== null ? formatBytes(snapshot.hardware.ramBytes) : '未知' }}。磁盘可用空间未测。</p>
            <p>设备可能为 CPU、MPS 或 GPU；上报内存不是可用剩余量。信息来自已连接的服务，可能对应其他实例，不据此承诺显存充足或出图成功。</p>
          </div>
        </div>
      </details>
      <CompanionWorkspaceSettings v-if="desktop" :open="workspaceOpen" v-model="workspaceDraft" :saving="workspaceSaving" :error="workspaceError" :return-focus-el="workspaceButton" @close="closeWorkspace" @save="saveWorkspace" />
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import ArchiveIcon from './visual/ArchiveIcon.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import LocalSetupPreparation from './LocalSetupPreparation.vue'
import LocalSetupAutomation from './LocalSetupAutomation.vue'
import { modelPreparationState, formatSetupBytes as formatBytes } from '../utils/localSetupPreparation.ts'
import CompanionWorkspaceSettings from './CompanionWorkspaceSettings.vue'
import { localSetupApi } from '../api/localSetupApi.ts'
import { isLocalStudioHost } from '../utils/runtimeEnvironment.ts'
import { getDesktopCapabilities } from '../platform/desktop/capabilities.ts'
import { STARTER_MODEL_SETTING, settingsRepository } from '../storage/settingsRepository'
import { flushProfileWrites } from '../platform/web/profileStorage'
import type { LocalSetupFileState, LocalSetupResponse, LocalSetupVerificationResult, LocalSetupDownloadResult } from '../../types/local-setup.ts'

const isLocal = isLocalStudioHost()
const desktop = isLocal ? getDesktopCapabilities() : undefined
const snapshot = ref<LocalSetupResponse | null>(null)
const selectedModel = ref(settingsRepository.get(STARTER_MODEL_SETTING) || 'anima-miaomiao-v1.6')
function selectSetupModel(modelId:string) {
  if(selectedModel.value===modelId)return
  selectedModel.value=modelId
  // A model change owns a new readiness check; a late previous result is no longer relevant.
  controller?.abort();controller=null;loading.value=false
  void refresh()
}
async function restartForSetup(){
  try{await flushProfileWrites();await desktop?.restartForSetup?.()}
  catch(cause){workspaceError.value=cause instanceof Error?cause.message:'重启未完成，请完全退出后重新打开绘遇'}
}
const verificationFailures = ref<Record<string, string>>({})
const downloadNotice = ref(''), workspacePending = ref(false)
const workspaceActiveRoot = ref<string | null>(null)
const workspaceUnconfirmed = computed(() => !!desktop && workspaceActiveRoot.value !== snapshot.value?.workspace.path)
let workspaceRead = 0
const loading = ref(false), error = ref(''), cancelled = ref(false)
let controller: AbortController | null = null
let disposed = false
const recommendedModels = computed(() => snapshot.value?.models.filter(model => model.required) ?? [])
const otherModels = computed(() => snapshot.value?.models.filter(model => !model.required && (!model.kind || model.kind === 'image')) ?? [])
const presentRecommended = computed(() => recommendedModels.value.filter(model => modelPreparationState(model) === 'bytes-match').length)
const nodesChecked = computed(() => snapshot.value?.nodes.state === 'checked' && snapshot.value.nodes.required.length > 0)
const failedModels = computed(() => recommendedModels.value.filter(model => verificationFailures.value[model.id] === model.path))
function recordVerification(result: LocalSetupVerificationResult) {
  const failures = { ...verificationFailures.value }
  if (result.state === 'sha256-match') delete failures[result.modelId]
  else failures[result.modelId] = result.path
  verificationFailures.value = failures
}
function recordDownload(result: LocalSetupDownloadResult) {
  if (result.state === 'failed') {
    if (result.code === 'MODEL_CONFLICT') verificationFailures.value = { ...verificationFailures.value, [result.modelId]: result.path }
    return
  }
  downloadNotice.value = result.message
  const failures = { ...verificationFailures.value }; delete failures[result.modelId]; verificationFailures.value = failures
  void refresh()
}
const basicComplete = computed(() => !loading.value && !error.value && !cancelled.value && failedModels.value.length === 0 && !!snapshot.value && snapshot.value.workspace.state === 'present'
  && snapshot.value.comfy.installation === 'present' && snapshot.value.comfy.connection === 'online'
  && recommendedModels.value.length >= 3 && presentRecommended.value === recommendedModels.value.length
  && nodesChecked.value && snapshot.value.nodes.missing.length === 0)
const connectionLabel = computed(() => snapshot.value?.comfy.connection === 'online' ? '在线' : snapshot.value?.comfy.connection === 'offline' ? '未连接' : '未知')
const nodeLabel = computed(() => !nodesChecked.value ? '尚未确认' : snapshot.value!.nodes.missing.length ? `缺少 ${snapshot.value!.nodes.missing.length} 项` : '所需节点已注册')
const checkedAtLabel = computed(() => snapshot.value ? new Date(snapshot.value.checkedAt).toLocaleTimeString('zh-CN') + ' 检查' : '')
const summary = computed(() => loading.value ? '正在读取本机配置…' : error.value ? '检查未完成，状态待确认'
  : cancelled.value ? '检查已取消' : basicComplete.value ? '基础只读检查已完成，尚未真实出图'
    : snapshot.value ? '推荐起步路径还有项目待确认' : '尚未检查')
const nextStep = computed(() => {
  const value = snapshot.value
  if (loading.value) return '等待本次只读检查，或取消后稍后再试。'
  if (error.value || cancelled.value) return '本次检查尚未确认；保留的路径来自上次结果，请重新检查后再判断准备状态。'
  if (!value) return '重新检查以读取当前配置；此操作不会安装文件或启动服务。'
  if (failedModels.value.length) return `${failedModels.value.map(model => model.label).join('、')} 的完整性校验未通过。重新检查不会清除此问题；请核对文件并重新校验 SHA-256 后再尝试出图。`
  if (value.workspace.state !== 'present' || value.comfy.installation !== 'present') return '先选择 AI 数据磁盘，再用下方一键准备环境与模型。已有服务可在手动管理中核对。'
  if (presentRecommended.value < recommendedModels.value.length) return '打开准备向导，按来源、大小与精确路径补齐或核对推荐组合；已有其他底模仍可按原配置使用。'
  if (value.comfy.connection !== 'online') return '用下方一键准备或控制室启动 ComfyUI；外部管理的环境沿用原入口。'
  if (!nodesChecked.value) return '节点注册信息尚未确认，请核对连接的 ComfyUI 服务后重新检查。'
  if (value.nodes.missing.length) return '按下方缺少的节点注册名检查 ComfyUI 扩展，手动重启该服务后重新检查。'
  return '去工作台生成一张全龄图片，或进入角色房间发送短消息，确认本机实际效果。'
})
const fileLabel = (state: LocalSetupFileState) => ({ present: '已发现', missing: '未发现', unknown: '未知' })[state]
async function refresh() {
  if (!isLocal || loading.value || disposed) return
  const request = new AbortController()
  controller = request
  loading.value = true; error.value = ''; cancelled.value = false
  // Keep the download owner mounted; a new snapshot still resets read-only verification.
  if (snapshot.value) snapshot.value = { ...snapshot.value }
  if (desktop) void readWorkspaceBinding()
  try {
    const result = await localSetupApi.getStatus({ signal: request.signal, modelId: selectedModel.value })
    if (!disposed && controller === request && !request.signal.aborted) snapshot.value = result
  } catch (cause) {
    if (!disposed && controller === request && !request.signal.aborted) error.value = cause instanceof Error ? cause.message : '读取配置失败，请重新检查。'
  } finally {
    if (!disposed && controller === request) { loading.value = false; controller = null }
  }
}
function cancelCheck() {
  ++workspaceRead
  controller?.abort(); controller = null; loading.value = false; error.value = ''; cancelled.value = true
}

const workspaceButton = ref<HTMLElement | null>(null)
const workspaceOpen = ref(false), workspaceDraft = ref(''), workspaceLoading = ref(false), workspaceSaving = ref(false)
const workspaceNotice = ref(''), workspaceError = ref('')
async function readWorkspaceBinding() {
  if (!desktop || disposed || workspaceSaving.value) return
  const read = ++workspaceRead
  workspaceError.value = ''
  try {
    const result = await desktop.getWorkspace()
    if (!disposed && read === workspaceRead) { workspaceActiveRoot.value = result.activeRoot; workspacePending.value = result.restartRequired }
  } catch (cause) {
    if (!disposed && read === workspaceRead) { workspaceActiveRoot.value = null; workspaceError.value = cause instanceof Error ? cause.message : '当前工作区尚未确认，请重新读取。' }
  }
}
async function openWorkspace() {
  if (!desktop || workspaceLoading.value || workspaceSaving.value || disposed) return
  workspaceLoading.value = true; workspaceError.value = ''
  ++workspaceRead
  try {
    const result = await desktop.getWorkspace()
    if (!disposed) {
      workspaceDraft.value = result.root
      workspacePending.value = result.restartRequired
      workspaceActiveRoot.value = result.activeRoot
      workspaceNotice.value = result.restartRequired ? '已保存的 AI 工作区尚未生效，完全退出并重启绘遇后使用新目录。当前检查仍基于本次运行时目录。' : ''
      workspaceOpen.value = true
    }
  } catch (cause) {
    if (!disposed) workspaceError.value = cause instanceof Error ? cause.message : '读取 AI 工作区失败。'
  } finally { if (!disposed) workspaceLoading.value = false }
}
function closeWorkspace() { if (!workspaceSaving.value) workspaceOpen.value = false }
async function saveWorkspace() {
  if (!desktop || workspaceSaving.value || !workspaceOpen.value || disposed) return
  workspaceSaving.value = true; workspaceError.value = ''; workspaceNotice.value = ''
  ++workspaceRead
  try {
    const result = await desktop.setWorkspace(workspaceDraft.value.trim())
    if (!disposed) {
      workspaceDraft.value = result.root
      workspacePending.value = result.restartRequired
      workspaceActiveRoot.value = result.activeRoot
      workspaceOpen.value = false
      workspaceNotice.value = result.restartRequired
        ? 'AI 工作区已保存，完全退出并重启绘遇后生效。当前检查仍基于本次运行时目录。'
        : 'AI 工作区已保存，当前运行时目录未改变。'
    }
  } catch (cause) {
    if (!disposed) workspaceError.value = cause instanceof Error ? cause.message : '保存失败，工作区尚未确认变更。'
  } finally { if (!disposed) workspaceSaving.value = false }
}
onMounted(() => { void refresh() })
onUnmounted(() => { disposed = true; controller?.abort(); controller = null })
</script>

<style scoped>
@reference "../assets/css/tailwind.css";
.local-setup { border:1px solid var(--border-soft); background:var(--bg-surface); overflow-wrap:anywhere; }
.setup-heading, .setup-actions { display:flex; align-items:center; flex-wrap:wrap; gap:var(--s-2); }
.setup-heading { justify-content:space-between; gap:var(--s-3); }
.panel-heading { margin:0; font-size:var(--fs-title-sm); }
.setup-scope, .setup-note, .setup-next, .setup-detail p { color:var(--text-secondary); font-size:var(--fs-label); line-height:var(--lh-body); margin:var(--s-3) 0; }
.setup-result { display:flex; align-items:center; gap:var(--s-2); font-size:var(--fs-label); margin-top:var(--s-4); }
.setup-result[data-state="checked"] { color:var(--success-text); }
.setup-overview { display:flex; flex-wrap:wrap; gap:var(--s-2) var(--s-4); margin-top:var(--s-2); color:var(--text-secondary); font-size:var(--fs-label-xs); }
.setup-next strong { color:var(--text-primary); margin-right:var(--s-2); }
.setup-error { color:var(--danger-text); font-size:var(--fs-label); overflow-wrap:anywhere; }
.setup-detail .setup-warning { color:var(--warning-text); }
.setup-details { margin-top:var(--s-4); border-top:1px solid var(--border-soft); }
.setup-details summary { padding-top:var(--s-3); cursor:pointer; font-size:var(--fs-label); }
.setup-details summary span { display:inline-block; margin-left:var(--s-3); font-size:var(--fs-label-xs); color:var(--text-muted); }
.setup-detail-body { display:grid; gap:var(--s-4); margin-top:var(--s-4); }
.setup-detail { min-width:0; padding:var(--s-3); border-radius:var(--r-md); background:var(--bg-deep); }
.setup-detail h3, .setup-detail h4 { font-size:var(--fs-label); margin:0 0 var(--s-2); }
.setup-detail h4 { margin-top:var(--s-4); }
.setup-detail code { display:block; overflow-wrap:anywhere; font-size:var(--fs-label-xs); color:var(--text-secondary); }
.setup-models { list-style:none; padding:0; margin:0; display:grid; gap:var(--s-3); }
.setup-models li > div { display:flex; flex-wrap:wrap; justify-content:space-between; gap:var(--s-2); margin-bottom:var(--s-1); font-size:var(--fs-label); }
.setup-models span { color:var(--text-secondary); font-size:var(--fs-label-xs); }
.setup-models span[data-state="missing"] { color:var(--warning-text); }
.setup-devices { padding-left:var(--s-4); color:var(--text-secondary); font-size:var(--fs-label); line-height:var(--lh-body); }
.setup-links { display:flex; flex-wrap:wrap; gap:var(--s-2) var(--s-4); }
.setup-detail a { font-size:var(--fs-label); color:var(--accent); text-underline-offset:3px; }
.setup-actions button:disabled { color:var(--text-disabled); opacity:1; cursor:not-allowed; }
.local-setup :is(button, a, summary):focus-visible { outline:2px solid var(--text-primary); outline-offset:3px; }
</style>
