<template>
  <div class="setup-automation">
    <p v-if="automation.error.value" ref="errorEl" tabindex="-1" class="setup-error" role="alert">{{ automation.error.value }}</p>
    <div v-if="automation.operationUncertain.value" class="setup-blocker" role="status"><ArchiveIcon name="info" /><span>后台进度尚未确认</span><button class="btn btn-primary btn-sm" type="button" @click="automation.retryOperation">继续核对进度</button></div>
    <template v-if="automation.completed.value">
      <div class="setup-finished" role="status">
        <span class="setup-finished-mark"><ArchiveIcon name="success" /></span>
        <h3>{{ automation.engineRestartRequired.value ? '重启后就可以开始了' : '资源已准备好' }}</h3>
        <div class="setup-finished-items"><span v-if="automation.drawing.value"><ArchiveIcon name="model" />{{ selectedImage?.label }}</span><span v-if="selectedChat"><ArchiveIcon name="chat" />{{ selectedChat.label }}</span></div>
        <div class="setup-buttons">
          <button v-if="automation.engineRestartRequired.value && canRestart" class="btn btn-primary" type="button" :disabled="restarting" @click="emit('restart')"><ArchiveIcon name="refresh" />{{ restarting ? '正在重启…' : '重启以启用绘图' }}</button>
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
      <div class="setup-progress" role="status" aria-live="polite">
        <ArchiveIcon name="download" /><h3>{{ activePackage?.label || progressSteps[stageIndex]?.label || '正在核对准备进度' }}</h3>
        <template v-if="automation.download.activeId.value">
          <progress :value="automation.download.bytesRead.value" :max="automation.download.expectedBytes.value || 1" aria-label="当前文件进度" />
          <div class="setup-progress-numbers"><span>{{ downloadPhaseLabel }}</span><strong>{{ progressPercent }}%</strong><span>{{ formatBytes(automation.download.bytesRead.value) }} / {{ formatBytes(automation.download.expectedBytes.value) }}</span></div>
        </template>
        <p>{{ automation.message.value }}</p>
        <button class="btn btn-ghost" type="button" :disabled="automation.recoveryPending.value || ['pending', 'accepted'].includes(automation.cancelState.value)" @click="automation.cancel">{{ automation.cancelState.value === 'pending' ? '取消中…' : automation.cancelState.value === 'accepted' ? '等待步骤结束…' : automation.cancelState.value === 'failed' ? '重试取消' : '取消准备' }}</button>
      </div>
    </template>
    <template v-else>
      <div class="setup-choice-grid">
        <div class="setup-choices">
          <article class="setup-choice" :data-selected="automation.drawing.value">
            <label class="setup-choice-toggle"><input v-model="automation.drawing.value" type="checkbox" /><ArchiveIcon name="image" /><strong>AI 绘图</strong><span class="setup-badge">推荐</span></label>
            <div v-if="automation.drawing.value" class="setup-choice-body">
              <div class="setup-model-card"><ArchiveIcon name="model" /><div><strong>{{ selectedImage?.label }}</strong><span>{{ selectedImage ? formatBytes(selectedImage.preparation!.expectedBytes) : '' }} · 绘图模型</span></div></div>
              <details class="setup-model-picker"><StudioDisclosureSummary>更换模型</StudioDisclosureSummary><StudioSelect id="setup-image-model" v-model="automation.modelId.value" label="绘图模型" :options="imageOptions" /></details>
              <label class="setup-addon"><input v-model="automation.loras.value" type="checkbox" /><span><strong>宁宁 / 夏目角色包</strong><small>角色绘图所需 LoRA</small></span></label>
            </div>
          </article>
          <article class="setup-choice" :data-selected="chatEnabled">
            <label class="setup-choice-toggle"><input v-model="chatEnabled" type="checkbox" /><ArchiveIcon name="chat" /><strong>本地聊天</strong><span class="setup-optional">可选</span></label>
            <div v-if="chatEnabled" class="setup-choice-body">
              <StudioSelect id="setup-chat-model" v-model="automation.chatId.value" label="聊天模型" :options="chatOptions" />
              <small>{{ automation.recommendation.value.label }} · 使用本机聊天</small>
            </div>
          </article>
          <div v-if="automation.drawing.value && automation.externalEnvironment.value" class="setup-existing">
            <ArchiveIcon name="info" /><strong>使用已有 ComfyUI</strong><small>从原入口启动，再回到这里检查。</small>
            <div class="setup-buttons"><button class="btn btn-ghost btn-sm" type="button" @click="emit('refresh')">重新检查连接</button><button class="btn btn-quiet btn-sm" type="button" @click="emit('workspace')">换新文件夹自动安装</button></div>
          </div>
          <div v-else-if="automation.drawing.value && snapshot.comfy.layout !== 'venv'" class="setup-runtime">
            <label for="setup-comfy-runtime">绘图运行环境</label>
            <StudioSelect id="setup-comfy-runtime" v-model="automation.environment.value" label="绘图运行环境" placeholder="选择适合显卡的运行包" :options="[{ value: 'comfy-nvidia', label: 'NVIDIA 显卡 · CUDA 13.0（默认）' }, { value: 'comfy-cu126', label: '较旧 NVIDIA 显卡 · CUDA 12.6' }]" />
          </div>
          <div v-if="automation.chatId.value" class="setup-runtime"><label for="setup-llama-runtime">聊天运行环境</label><StudioSelect id="setup-llama-runtime" v-model="automation.llamaEnvironment.value" label="聊天运行环境" :options="[{ value: 'llama-cuda', label: 'NVIDIA 显卡 · CUDA（默认）' }, { value: 'llama-vulkan', label: 'Vulkan · 进阶选项' }]" /></div>
        </div>
        <div class="setup-manifest">
          <div class="setup-manifest-heading"><h3>本次下载</h3><strong>{{ formatBytes(automation.downloadBytes.value) }}</strong></div>
          <ul class="setup-packages">
            <li v-for="model in automation.plan.value" :key="model.id"><ArchiveIcon :name="packagePresent(model) ? 'success' : model.kind === 'runtime' ? 'gear' : model.kind === 'chat' ? 'chat' : 'model'" /><div><strong>{{ packageName(model) }}</strong><span>{{ packagePresent(model) ? '已有文件 · 将校验' : formatBytes(model.preparation!.expectedBytes) }}</span></div><a :href="model.preparation!.licenseUrl" target="_blank" rel="noopener noreferrer" :aria-label="`${model.label}的使用许可，在新窗口打开`">许可</a></li>
          </ul>
          <div class="setup-manifest-note"><ArchiveIcon name="folder" /><span>解压需额外空间 · 中断可续传</span></div>
        </div>
      </div>
      <div class="setup-submit">
        <div v-if="automation.serviceMustStop.value" class="setup-submit-blocker" role="status"><ArchiveIcon name="warning" /><span>补装节点前，请先停止 ComfyUI。</span><a class="btn btn-ghost btn-sm" href="#control-overview">去停止服务</a><button class="btn btn-ghost btn-sm" type="button" @click="emit('refresh')">已停止，重新检查</button></div>
        <div v-if="workspaceBlocked || !statusConfirmed || automation.environmentRequired.value || !automation.hasSelection.value" class="setup-submit-blocker" role="status"><ArchiveIcon name="info" /><span>{{ workspaceBlocked ? '请先确认存放位置。' : !statusConfirmed ? '配置检查尚未完成。' : automation.environmentRequired.value ? '请选择上方的绘图运行环境。' : '选择 AI 绘图或本地聊天。' }}</span><button v-if="!statusConfirmed && !workspaceBlocked" class="btn btn-ghost btn-sm" type="button" @click="emit('refresh')">重新检查</button></div>
        <label class="setup-review"><input v-model="automation.reviewed.value" type="checkbox" :disabled="!automation.hasSelection.value" /><span>同意下载、安装并启用所选功能及其<a v-if="automation.hasSelection.value" :href="automation.drawing.value ? selectedImage?.preparation?.licenseUrl : selectedChat?.preparation?.licenseUrl" target="_blank" rel="noopener noreferrer">使用许可</a></span></label>
        <div class="setup-buttons"><button class="btn btn-primary" type="button" :disabled="!canRun" @click="automation.run"><ArchiveIcon name="download" />{{ automation.error.value ? '继续下载并配置' : '下载并自动配置' }}</button><button v-if="automation.canStartExisting.value" class="btn btn-ghost" type="button" :disabled="!statusConfirmed || workspaceBlocked" @click="automation.startExisting">使用已有环境</button></div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, toRef, watch } from 'vue'
import { RouterLink } from 'vue-router'
import type { LocalSetupResponse, LocalSetupDownloadResult, LocalSetupModel } from '../../types/local-setup'
import StudioSelect from './ui/StudioSelect.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import ArchiveIcon from './visual/ArchiveIcon.vue'
import { useLocalSetupAutomation } from '../composables/useLocalSetupAutomation'
import { formatSetupBytes as formatBytes, modelPreparationState } from '../utils/localSetupPreparation'
const props = defineProps<{ snapshot: LocalSetupResponse; workspaceBlocked: boolean; statusConfirmed: boolean; canRestart: boolean; restarting: boolean }>()
const emit = defineEmits<{ refresh: []; 'download-result': [result: LocalSetupDownloadResult]; 'model-selected': [modelId: string]; phase: [value: 'selection' | 'preparing' | 'ready']; restart: []; workspace: [] }>()
const automation = useLocalSetupAutomation(toRef(props, 'snapshot'), toRef(props, 'workspaceBlocked'), result => emit('download-result', result), () => emit('refresh'), toRef(props, 'statusConfirmed'))
const errorEl = ref<HTMLElement | null>(null)
watch(automation.error, async value => { if (value) { await nextTick(); errorEl.value?.focus() } })
watch(automation.modelId, model => emit('model-selected', model), { immediate: true })
watch([automation.busy, automation.completed], () => emit('phase', automation.busy.value ? 'preparing' : automation.completed.value ? 'ready' : 'selection'), { immediate: true })
const rank = (id: string) => id === 'anima-miaomiao-v1.6' ? 0 : id === 'anima-base-v1.0' ? 1 : id === 'anima-aesthetic-v1.1' ? 2 : 3
const imageOptions = computed(() => automation.imageModels.value.map(model => ({ value: model.id, label: model.label })).sort((a, b) => rank(a.value) - rank(b.value)))
const selectedImage = computed(() => automation.imageModels.value.find(model => model.id === automation.modelId.value))
const selectedChat = computed(() => automation.chatModels.value.find(model => model.id === automation.chatId.value))
const chatOptions = computed(() => automation.chatModels.value.map(model => ({ value: model.id, label: model.label + ' · ' + formatBytes(model.preparation!.expectedBytes) })))
const chatEnabled = computed({ get: () => !!automation.chatId.value, set: (enabled: boolean) => { automation.chatId.value = enabled ? automation.recommendation.value.modelId || automation.chatModels.value[0]?.id || '' : '' } })
const canRun = computed(() => props.statusConfirmed && !props.workspaceBlocked && !automation.environmentRequired.value && !automation.serviceMustStop.value && automation.reviewed.value && automation.hasSelection.value)
const progressSteps = computed(() => [{ id: 'environment', label: '安装环境' }, { id: 'models', label: '下载模型' }, { id: 'service', label: automation.drawing.value ? '启动服务' : '启动聊天' }, { id: 'validation', label: '检查配置' }])
const stageIndex = computed(() => progressSteps.value.findIndex(item => item.id === automation.stage.value))
const activePackage = computed(() => automation.plan.value.find(model => model.id === automation.download.activeId.value))
const progressPercent = computed(() => automation.download.expectedBytes.value ? Math.min(100, Math.floor(automation.download.bytesRead.value / automation.download.expectedBytes.value * 100)) : 0)
const downloadPhaseLabel = computed(() => automation.download.phase.value === 'checking' ? '检查已有文件' : automation.download.phase.value === 'verifying' ? '校验文件' : '正在下载')
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
.setup-choice[data-selected="true"] .setup-choice-toggle { background:var(--accent-soft); }
.setup-choice-toggle > .archive-icon { width:22px; height:22px; color:var(--accent); }
.setup-choice-toggle strong { flex:1; }
.setup-badge { padding:var(--s-1) var(--s-2); border-radius:var(--r-pill); color:var(--accent); font-size:var(--fs-label-sm); background:var(--bg-surface); }
.setup-optional, .setup-choice-body small { color:var(--text-secondary); font-size:var(--fs-label-sm); }
.setup-choice-body { display:grid; gap:var(--s-3); padding:var(--s-4); }
.setup-model-card { display:flex; align-items:center; gap:var(--s-3); }
.setup-model-card > .archive-icon { width:32px; height:32px; color:var(--accent); }
.setup-model-card > div { display:grid; gap:var(--s-1); }
.setup-model-card span { color:var(--text-secondary); font-size:var(--fs-label-sm); }
.setup-model-picker { font-size:var(--fs-label-sm); }
.setup-model-picker > summary { color:var(--text-secondary); }
.setup-model-picker[open] > summary { margin-bottom:var(--s-2); }
.setup-addon { display:flex; align-items:flex-start; gap:var(--s-2); border-top:1px solid var(--border-soft); padding-top:var(--s-3); cursor:pointer; }
.setup-addon span { display:grid; gap:var(--s-1); }
.setup-addon strong { font-size:var(--fs-label); font-weight:500; }
.setup-runtime { display:grid; gap:var(--s-2); font-size:var(--fs-label-sm); }
.setup-manifest { border:1px solid var(--border-soft); border-radius:var(--r-lg); background:var(--bg-deep); padding:var(--s-4); }
.setup-manifest-heading { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:var(--s-2); padding-bottom:var(--s-3); border-bottom:1px solid var(--border-soft); }
.setup-manifest-heading h3 { font-size:var(--fs-label); }
.setup-manifest-heading > strong { color:var(--accent); font-size:var(--fs-title-xs); }
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
.setup-progress { display:grid; justify-items:center; gap:var(--s-4); padding:var(--s-5); border:1px solid var(--border-soft); border-radius:var(--r-lg); background:var(--bg-deep); text-align:center; }
.setup-progress > .archive-icon { width:36px; height:36px; color:var(--accent); }
.setup-progress h3 { font-size:var(--fs-title-xs); }
.setup-progress progress { width:100%; accent-color:var(--accent); }
.setup-progress-numbers { display:flex; justify-content:space-between; gap:var(--s-3); width:100%; flex-wrap:wrap; color:var(--text-secondary); font-size:var(--fs-label-sm); }
.setup-progress-numbers strong { color:var(--text-primary); }
.setup-progress p { color:var(--text-secondary); font-size:var(--fs-label-sm); line-height:var(--lh-body); overflow-wrap:anywhere; }
.setup-finished { display:grid; justify-items:center; gap:var(--s-4); padding:var(--s-5); text-align:center; background:var(--bg-deep); border-radius:var(--r-lg); }
.setup-finished-mark { display:grid; place-items:center; width:64px; height:64px; border:1px solid var(--success-text); border-radius:var(--r-pill); color:var(--success-text); }
.setup-finished-mark .archive-icon { width:32px; height:32px; }
.setup-finished-items { display:grid; gap:var(--s-2); color:var(--text-secondary); font-size:var(--fs-label); }
.setup-finished-items span { display:flex; align-items:center; justify-content:center; gap:var(--s-2); }
.setup-finished small { color:var(--text-secondary); }
.setup-automation button:disabled { color:var(--text-disabled); opacity:1; cursor:not-allowed; }
.setup-automation :is(button,input,a,summary):focus-visible { outline:none; box-shadow:var(--focus-shadow); }
@media(max-width:1050px) { .setup-choice-grid { grid-template-columns:minmax(0,1fr); } }
</style>
