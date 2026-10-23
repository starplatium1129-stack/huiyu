<template>
  <div ref="automationRoot" class="setup-automation">
    <p v-if="automation.error.value" ref="errorEl" tabindex="-1" class="setup-error" role="alert">{{ automation.error.value }}</p>
    <div v-if="automation.operationUncertain.value" class="setup-blocker" role="status"><ArchiveIcon name="info" /><span>后台进度尚未确认</span><button class="btn btn-primary btn-sm" type="button" @click="automation.retryOperation">继续核对进度</button></div>
    <template v-if="automation.completed.value">
      <div class="setup-finished" role="status">
        <span class="setup-finished-mark"><ArchiveIcon name="success" /></span>
        <h3>{{ automation.engineRestartRequired.value ? '重启后就可以开始了' : '资源已准备好' }}</h3>
        <div class="setup-finished-items"><span v-if="automation.drawing.value"><ArchiveIcon name="model" />{{ selectedImage?.label }}</span><span v-if="selectedChat"><ArchiveIcon name="chat" />{{ selectedChat.label }}</span></div>
        <div class="setup-buttons">
          <button v-if="automation.engineRestartRequired.value && canRestart" class="btn btn-primary" type="button" :disabled="restarting || blocked" @click="emit('restart')"><ArchiveIcon name="refresh" />{{ restarting ? '正在重启…' : '重启以启用绘图' }}</button>
          <span v-else-if="automation.engineRestartRequired.value">退出并重新打开绘遇后，进入画室。</span>
          <RouterLink v-else-if="automation.drawing.value" class="btn btn-primary" :to="{ path: '/prompt-builder', query: { preparedModel: automation.modelId.value } }"><ArchiveIcon name="spark" />生成第一张图片</RouterLink>
          <RouterLink v-if="automation.chatId.value && !automation.engineRestartRequired.value" class="btn btn-ghost" to="/chat"><ArchiveIcon name="chat" />开始聊天</RouterLink>
        </div>
        <small v-if="automation.engineRestartRequired.value && canRestart">重启后打开画室</small>
      </div>
    </template>
    <template v-else-if="automation.busy.value">
      <ol class="setup-pipeline" aria-label="自动配置进度">
        <li v-for="(item, index) in progressSteps" :key="item.id" :data-current="automation.stage.value === item.id" :data-done="index < stageIndex" :aria-current="automation.stage.value === item.id ? 'step' : undefined"><span><ArchiveIcon v-if="index < stageIndex" name="success" /><template v-else>{{ index + 1 }}</template></span><strong>{{ item.label }}</strong></li>
      </ol>
      <SetupTransferProgress :title="activePackage?.label || progressSteps[stageIndex]?.label || '正在核对准备进度'"
        :phase="(automation.download.activeId.value ? automation.download.phase.value : automation.stage.value) ?? 'preparing'"
        :received="automation.download.bytesRead.value" :total="automation.download.expectedBytes.value"
        :completed-files="automation.workProgress.value?.done" :total-files="automation.workProgress.value?.total"
        :message="automation.download.activeId.value && automation.download.progressMessage.value || automation.message.value" scope="file">
        <button class="btn btn-ghost" type="button" :disabled="automation.recoveryPending.value || ['pending', 'accepted'].includes(automation.cancelState.value)" @click="automation.cancel">{{ automation.cancelState.value === 'pending' ? '取消中…' : automation.cancelState.value === 'accepted' ? '等待步骤结束…' : automation.cancelState.value === 'failed' ? '重试取消' : '取消准备' }}</button>
      </SetupTransferProgress>
    </template>
    <template v-else>
      <div class="setup-choice-grid">
        <div class="setup-choices">
          <article class="setup-choice" :data-selected="automation.drawing.value">
            <label class="setup-choice-toggle"><input v-model="automation.drawing.value" type="checkbox" /><ArchiveIcon name="image" /><strong>AI 绘图</strong><span class="setup-optional">入门推荐</span></label>
            <div class="setup-choice-body">
              <label for="setup-image-model" class="setup-field-label">选择绘图模型</label>
              <StudioSelect id="setup-image-model" v-model="automation.modelId.value" label="绘图模型" :options="imageOptions" :disabled="!automation.drawing.value" />
              <small v-if="selectedImage">{{ formatBytes(selectedImage.preparation!.expectedBytes) }} · ComfyUI</small>
              <label v-if="automation.drawing.value" class="setup-addon"><input v-model="automation.loras.value" type="checkbox" /><span><strong>添加宁宁 / 夏目角色包</strong><small>用于绘制这两位角色，其他绘图可以不选。</small></span></label>
            </div>
          </article>
          <article id="setup-chat-options" class="setup-choice" :data-selected="chatEnabled">
            <label class="setup-choice-toggle"><input v-model="chatEnabled" type="checkbox" /><ArchiveIcon name="chat" /><strong>本地聊天</strong><span class="setup-optional">可选</span></label>
            <div v-if="chatEnabled" class="setup-choice-body">
              <StudioSelect id="setup-chat-model" v-model="automation.chatId.value" label="聊天模型" :options="chatOptions" />
              <small>{{ automation.recommendation.value.label }} · 使用本机聊天</small>
            </div>
          </article>
          <details v-if="automation.drawing.value && snapshot.comfy.installation === 'present'"><StudioDisclosureSummary>修复环境</StudioDisclosureSummary><div data-disclosure-content><label class="setup-addon"><input v-model="automation.rebuildComfy.value" type="checkbox" /><span><strong>重新解压运行包</strong><small>旧环境与模型保留；仅在环境损坏时使用。</small></span></label></div></details>
          <div v-if="automation.drawing.value && automation.externalEnvironment.value" class="setup-existing">
            <ArchiveIcon name="info" /><strong>使用已有 ComfyUI</strong><small>从原入口启动，再回到这里检查。</small>
            <div class="setup-buttons"><button class="btn btn-ghost btn-sm" type="button" @click="emit('refresh')">重新检查连接</button><button v-if="canChooseWorkspace" class="btn btn-quiet btn-sm" type="button" @click="emit('workspace')">换新文件夹自动安装</button></div>
          </div>
          <div v-else-if="automation.drawing.value && (snapshot.comfy.installation !== 'present' || automation.rebuildComfy.value)" class="setup-runtime">
            <strong>Windows · NVIDIA 显卡</strong>
            <small>AMD / Intel 暂不支持自动安装</small>
            <details><StudioDisclosureSummary>显卡运行包选项</StudioDisclosureSummary><div data-disclosure-content><StudioSelect id="setup-comfy-runtime" v-model="automation.environment.value" label="绘图运行环境" placeholder="选择适合显卡的运行包" :options="[{ value: 'comfy-nvidia', label: 'NVIDIA 显卡 · CUDA 13.0（默认）' }, { value: 'comfy-cu126', label: '较旧 NVIDIA 显卡 · CUDA 12.6' }]" /></div></details>
          </div>
          <div v-if="automation.chatId.value && snapshot.chat?.runtimePresent" class="setup-existing" role="status">
            <ArchiveIcon name="info" /><strong>沿用已有聊天运行环境</strong>
            <small>已找到 Chat/runtime/llama-server.exe，尚未识别其 CUDA / Vulkan 类型。本次只准备所选聊天模型，不会替换或切换运行环境。</small>
            <small>若当前环境与显卡不兼容，请先停止聊天服务并核对运行目录；当前自动准备不支持切换已有聊天运行包。</small>
          </div>
          <div v-else-if="automation.chatId.value" class="setup-runtime"><label for="setup-llama-runtime">首次安装的聊天运行环境</label><StudioSelect id="setup-llama-runtime" v-model="automation.llamaEnvironment.value" label="首次安装的聊天运行环境" :options="[{ value: 'llama-cuda', label: 'NVIDIA 显卡 · CUDA（默认）' }, { value: 'llama-vulkan', label: 'Vulkan · 进阶选项' }]" /></div>
        </div>
        <div class="setup-manifest">
          <div class="setup-manifest-heading"><h3>本次下载</h3><strong>{{ formatBytes(automation.downloadBytes.value) }}</strong></div>
          <p v-if="!automation.hasSelection.value" class="setup-manifest-intro">请选择绘图或聊天</p>
          <ul class="setup-packages">
            <li v-for="model in automation.plan.value" :key="model.id"><ArchiveIcon :name="packagePresent(model) ? 'success' : model.kind === 'runtime' ? 'gear' : model.kind === 'chat' ? 'chat' : 'model'" /><div><strong>{{ packageName(model) }}</strong><span>{{ packagePresent(model) ? '已有文件 · 将校验' : formatBytes(model.preparation!.expectedBytes) }}</span></div><a :href="model.preparation!.licenseUrl" target="_blank" rel="noopener noreferrer" :aria-label="`${model.label}的使用许可，在新窗口打开`">许可</a></li>
          </ul>
          <div class="setup-manifest-note"><ArchiveIcon name="folder" /><span>解压需额外空间 · 中断可续传</span></div>
        </div>
      </div>
      <div class="setup-submit">
        <p v-if="blocked" class="setup-submit-blocker" role="status">另一项配置正在处理，请等它完成后再开始。</p>
        <div v-if="automation.serviceMustStop.value" class="setup-submit-blocker" role="status"><ArchiveIcon name="warning" /><span>重建环境前，请先停止 ComfyUI。</span><RouterLink class="btn btn-ghost btn-sm" :to="{ query: $route.query, hash: '#control-service-comfy' }">去停止服务</RouterLink><button class="btn btn-ghost btn-sm" type="button" @click="emit('refresh')">已停止，重新检查</button></div>
        <div v-if="workspaceBlocked || !statusConfirmed || automation.environmentRequired.value || !automation.hasSelection.value" class="setup-submit-blocker" role="status"><ArchiveIcon name="info" /><span>{{ workspaceBlocked ? '请先确认存放位置。' : !statusConfirmed ? '配置检查尚未完成。' : automation.environmentRequired.value ? '请选择上方的绘图运行环境。' : '选择 AI 绘图或本地聊天。' }}</span><button v-if="!statusConfirmed && !workspaceBlocked" class="btn btn-ghost btn-sm" type="button" @click="emit('refresh')">重新检查</button></div>
        <label class="setup-review"><input v-model="automation.reviewed.value" type="checkbox" :disabled="!automation.hasSelection.value" /><span>同意下载、安装并启用所选功能及其<a v-if="automation.hasSelection.value" :href="automation.drawing.value ? selectedImage?.preparation?.licenseUrl : selectedChat?.preparation?.licenseUrl" target="_blank" rel="noopener noreferrer">使用许可</a></span></label>
        <div class="setup-buttons"><button class="btn btn-primary" type="button" :disabled="!canRun" @click="automation.run"><ArchiveIcon name="download" />{{ automation.error.value ? '继续下载并配置' : '下载并自动配置' }}</button><button v-if="automation.canStartExisting.value" class="btn btn-ghost" type="button" :disabled="blocked || !statusConfirmed || workspaceBlocked" @click="automation.startExisting">使用已有环境</button></div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, toRef, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import type { LocalSetupResponse, LocalSetupDownloadResult, LocalSetupModel } from '../../types/local-setup'
import StudioSelect from './ui/StudioSelect.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import SetupTransferProgress from '@/components/control/SetupTransferProgress.vue'
import ArchiveIcon from './visual/ArchiveIcon.vue'
import { useLocalSetupAutomation } from '../composables/useLocalSetupAutomation'
import { formatSetupBytes as formatBytes, modelPreparationState } from '../utils/localSetupPreparation'
const props = defineProps<{ snapshot: LocalSetupResponse; workspaceBlocked: boolean; blocked: boolean; settingsRevision: number; statusConfirmed: boolean; canRestart: boolean; canChooseWorkspace: boolean; restarting: boolean }>()
const emit = defineEmits<{ refresh: []; configured: []; 'download-result': [result: LocalSetupDownloadResult]; 'model-selected': [modelId: string]; phase: [value: 'selection' | 'preparing' | 'ready']; restart: []; workspace: [] }>()
const automation = useLocalSetupAutomation(toRef(props, 'snapshot'), computed(() => props.blocked || props.workspaceBlocked), result => emit('download-result', result), () => emit('refresh'), toRef(props, 'statusConfirmed'), () => emit('configured'))
const route = useRoute()
watch(() => props.settingsRevision, () => {
  if (!automation.busy.value) { automation.completed.value = false; automation.engineRestartRequired.value = false }
})
watch(() => route.fullPath, async () => {
  if (route.path !== '/control' || route.hash !== '#setup-chat-options') return
  await nextTick()
  const target = document.getElementById('setup-chat-options')
  if (target?.getClientRects().length) target.scrollIntoView({ block: 'start', behavior: 'instant' })
}, { immediate: true })
const errorEl = ref<HTMLElement | null>(null)
const automationRoot = ref<HTMLElement | null>(null)
watch(automation.error, async value => {
  const origin = document.activeElement
  if (!value || !(origin instanceof HTMLElement) || !automationRoot.value?.contains(origin)) return
  await nextTick()
  if (automation.error.value === value && errorEl.value?.isConnected && (document.activeElement === document.body
    || document.activeElement === origin && !origin.getClientRects().length)) errorEl.value.focus({ preventScroll: true })
})
watch(automation.modelId, model => emit('model-selected', model), { immediate: true })
watch([automation.busy, automation.completed], () => emit('phase', automation.busy.value ? 'preparing' : automation.completed.value ? 'ready' : 'selection'), { immediate: true })
const imageOptions = computed(() => [...automation.imageModels.value].sort((a, b) => Number(b.id === props.snapshot.recommendedModel) - Number(a.id === props.snapshot.recommendedModel))
  .map(model => ({ value: model.id, label: model.label + (model.id === props.snapshot.recommendedModel && !model.label.includes('推荐') ? ' · 推荐' : '') })))
const selectedImage = computed(() => automation.imageModels.value.find(model => model.id === automation.modelId.value))
const selectedChat = computed(() => automation.chatModels.value.find(model => model.id === automation.chatId.value))
const chatOptions = computed(() => automation.chatModels.value.map(model => ({ value: model.id, label: model.label + ' · ' + formatBytes(model.preparation!.expectedBytes) })))
const chatEnabled = computed({ get: () => !!automation.chatId.value, set: (enabled: boolean) => { automation.chatId.value = enabled ? automation.recommendation.value.modelId || automation.chatModels.value[0]?.id || '' : '' } })
const canRun = computed(() => !props.blocked && props.statusConfirmed && !props.workspaceBlocked && !automation.environmentRequired.value && !automation.serviceMustStop.value && automation.reviewed.value && automation.hasSelection.value)
const progressSteps = computed(() => [{ id: 'environment', label: '安装环境' }, { id: 'models', label: '下载模型' }, { id: 'service', label: automation.drawing.value ? '启动服务' : '启动聊天' }, { id: 'validation', label: '检查配置' }])
const stageIndex = computed(() => progressSteps.value.findIndex(item => item.id === automation.stage.value))
const activePackage = computed(() => automation.plan.value.find(model => model.id === automation.download.activeId.value))
const packagePresent = (model: LocalSetupModel) => modelPreparationState(model) === 'bytes-match'
function packageName(model: LocalSetupModel) { return model.id === 'qwen-encoder' ? '文字编码器' : model.id === 'qwen-vae' ? '图像解码器' : model.id.startsWith('runtime-comfy') ? 'ComfyUI 绘图环境' : model.id === 'runtime-kjnodes' ? '绘图必需节点' : model.id === 'runtime-anima-teacache' ? '绘图加速节点' : model.label }
</script>

<style scoped>
.setup-automation { display:grid; gap:var(--s-4); }
.setup-automation h3, .setup-automation p { margin:0; }
.setup-choice-grid { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:var(--s-5); align-items:start; }
.setup-choices { display:grid; gap:var(--s-3); }
.setup-choice { border:1px solid var(--border-strong); border-radius:var(--r-lg); background:var(--bg-deep); overflow:hidden; }
.setup-choice-toggle { display:flex; align-items:center; gap:var(--s-3); padding:var(--s-4); cursor:pointer; min-height:48px; }
.setup-choice[data-selected="true"] .setup-choice-toggle { background:var(--bg-elevated); }
.setup-choice-toggle > .archive-icon { width:22px; height:22px; color:var(--accent); }
.setup-choice-toggle strong { flex:1; }
.setup-optional, .setup-choice-body small { color:var(--text-secondary); font-size:var(--fs-label-sm); }
.setup-choice-body { display:grid; gap:var(--s-3); padding:var(--s-4); }
.setup-field-label { font-size:var(--fs-label-sm); font-weight:500; }
.setup-choice { scroll-margin-top:100px; }
.setup-addon { display:flex; align-items:flex-start; gap:var(--s-2); border-top:1px solid var(--border-soft); padding-top:var(--s-3); cursor:pointer; }
.setup-addon span { display:grid; gap:var(--s-1); }
.setup-addon strong { font-size:var(--fs-label); font-weight:500; }
.setup-runtime { display:grid; gap:var(--s-2); font-size:var(--fs-label-sm); }
.setup-runtime > small { color:var(--text-secondary); line-height:var(--lh-body); }
.setup-runtime > details { border-top:1px solid var(--border-soft); padding-top:var(--s-2); }
.setup-manifest { border:1px solid var(--border-soft); border-radius:var(--r-lg); background:var(--bg-deep); padding:var(--s-4); }
.setup-manifest-heading { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:var(--s-2); padding-bottom:var(--s-3); border-bottom:1px solid var(--border-soft); }
.setup-manifest-heading h3 { font-size:var(--fs-label); }
.setup-manifest-heading > strong { color:var(--accent); font-size:var(--fs-title-xs); font-variant-numeric:tabular-nums; min-inline-size:8ch; text-align:end; }
.setup-automation .setup-manifest-intro { margin-top:var(--s-3); color:var(--text-secondary); font-size:var(--fs-label-sm); line-height:var(--lh-body); }
.setup-packages { display:grid; gap:var(--s-3); list-style:none; padding:var(--s-4) 0; margin:0; }
.setup-packages li { display:flex; align-items:center; gap:var(--s-3); min-width:0; }
.setup-packages .archive-icon { color:var(--text-secondary); width:20px; height:20px; }
.setup-packages li > div { display:grid; gap:var(--s-1); flex:1; min-width:0; }
.setup-packages strong { font-size:var(--fs-label-sm); font-weight:500; }
.setup-packages span, .setup-packages a { font-size:var(--fs-label-xs); color:var(--text-secondary); }
.setup-packages a { text-underline-offset:3px; flex-shrink:0; }
.setup-manifest-note { display:flex; align-items:center; gap:var(--s-2); padding-top:var(--s-3); border-top:1px solid var(--border-soft); color:var(--text-secondary); font-size:var(--fs-label-sm); }
.setup-buttons { display:flex; align-items:center; flex-wrap:wrap; gap:var(--s-2); }
.setup-buttons .btn { flex-shrink:0; min-height:44px; }
.setup-submit { position:sticky; bottom:var(--s-3); z-index:2; display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:var(--s-3); padding:var(--s-3) var(--s-4); border:1px solid var(--border-strong); border-radius:var(--r-lg); background:var(--bg-surface); box-shadow:var(--shadow-lg); }
.setup-submit-blocker { display:flex; align-items:center; gap:var(--s-2); flex-basis:100%; font-size:var(--fs-label-sm); }
.setup-submit-blocker > span { flex:1; }
.setup-review { display:flex; align-items:flex-start; gap:var(--s-2); font-size:var(--fs-label-sm); color:var(--text-secondary); line-height:var(--lh-body); }
.setup-review a { color:var(--text-primary); text-underline-offset:3px; }
.setup-automation input[type="checkbox"] { width:18px; height:18px; flex-shrink:0; accent-color:var(--accent); cursor:pointer; }
.setup-blocker, .setup-existing { display:flex; align-items:center; flex-wrap:wrap; gap:var(--s-2); padding:var(--s-3); border:1px solid var(--border-soft); border-radius:var(--r-md); font-size:var(--fs-label-sm); }
.setup-blocker > span { flex:1; }
.setup-existing small, .setup-existing .setup-buttons { flex-basis:100%; }
.setup-existing small { color:var(--text-secondary); line-height:var(--lh-body); }
.setup-error { padding:var(--s-3); border:1px solid var(--danger-text); border-radius:var(--r-md); color:var(--danger-text); overflow-wrap:anywhere; line-height:var(--lh-body); }
.setup-pipeline { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:var(--s-2); margin:0; padding:0; list-style:none; }
.setup-pipeline li { display:grid; justify-items:center; gap:var(--s-2); padding:var(--s-3); color:var(--text-secondary); font-size:var(--fs-label-sm); }
.setup-pipeline li > span { display:grid; place-items:center; width:32px; height:32px; border:1px solid var(--border-strong); border-radius:var(--r-pill); }
.setup-pipeline li[data-current="true"] { color:var(--accent); background:var(--accent-soft); border-radius:var(--r-md); }
.setup-pipeline li[data-done="true"] { color:var(--success-text); }
.setup-finished { display:grid; justify-items:center; gap:var(--s-4); padding:var(--s-5); text-align:center; background:var(--bg-deep); border-radius:var(--r-lg); }
.setup-finished-mark { display:grid; place-items:center; width:64px; height:64px; border:1px solid var(--success-text); border-radius:var(--r-pill); color:var(--success-text); }
.setup-finished-mark .archive-icon { width:32px; height:32px; }
.setup-finished-items { display:grid; gap:var(--s-2); color:var(--text-secondary); font-size:var(--fs-label); }
.setup-finished-items span { display:flex; align-items:center; justify-content:center; gap:var(--s-2); }
.setup-finished small { color:var(--text-secondary); }
.setup-automation button:disabled { color:var(--text-disabled); opacity:1; cursor:not-allowed; }
.setup-automation :is(button,input,a,summary):focus-visible { outline:none; box-shadow:var(--focus-shadow); }
@container(max-width:720px) { .setup-choice-grid { grid-template-columns:minmax(0,1fr); } }
</style>
