<template>
  <section ref="panel" class="inference-setup" aria-labelledby="native-setup-title">
    <div class="setup-intro">
      <span class="setup-mark"><ArchiveIcon name="spark" /></span>
      <div><h3 id="native-setup-title" ref="title" tabindex="-1">让画室准备好</h3><p>自动准备运行库和模型，无需手工配置。</p></div>
    </div>
    <ol class="setup-route" aria-label="配置流程">
      <li :data-ready="currentPlan"><span>1</span>选择位置</li>
      <li :data-ready="currentPlan && !!plan?.supported && !!plan.runtime.installed && !!selectedModel?.installed"><span>2</span>自动准备</li>
      <li :data-ready="nativeEnabled"><span>3</span>开始创作</li>
    </ol>
    <div class="setup-location">
      <ArchiveIcon name="detail" />
      <div><span class="setup-label">AI 工作区</span><code>{{ workspaceDraft || plan?.workspacePath || '正在读取…' }}</code><small v-if="!workspacePending && plan?.freeBytes !== null && plan?.freeBytes !== undefined">剩余 {{ formatSetupBytes(plan.freeBytes) }}</small></div>
      <div class="setup-actions"><button v-if="desktop" ref="workspaceButton" class="btn btn-quiet btn-sm" type="button" :disabled="locked" @click="openWorkspace">更改</button><button v-if="desktop && plan && !workspacePending" class="btn btn-quiet btn-sm" type="button" @click="openFolder">打开</button></div>
    </div>
    <p v-if="workspaceError" class="setup-error" role="alert">{{ workspaceError }}</p>
    <div v-if="workspacePending" class="setup-status" role="status"><ArchiveIcon name="info" /><div><strong>存放位置已更改</strong><p>重启绘遇后，在新目录继续准备。已有文件会保留。</p></div></div>
    <template v-else-if="plan">
      <div class="setup-status" :data-state="nativeEnabled ? 'ready' : plan.supported ? 'available' : 'unavailable'" role="status">
        <ArchiveIcon :name="plan.supported ? 'success' : 'info'" />
        <div><strong>{{ nativeEnabled ? '原生引擎已就绪' : plan.supported ? '这台电脑可以准备原生生图' : unavailableTitle }}</strong><p>{{ deviceName }}<span v-if="plan.supported && !nativeEnabled"> · 设备检查通过</span></p><p v-if="!plan.supported">{{ unavailableHint }}</p></div>
        <button v-if="plan.supported" class="btn btn-quiet btn-sm" type="button" :disabled="locked" @click="refreshPlan">重新检查</button>
      </div>
      <template v-if="plan.supported && selectedModel && !nativeEnabled && !pendingRestart">
        <div class="setup-model">
          <div class="setup-model-copy"><ArchiveIcon name="model" /><div><span class="setup-label">绘图模型</span><strong>{{ modelName }}</strong><small>官方完整模型 · 无需转换</small></div></div>
          <StudioSelect v-if="modelOptions.length > 1" id="native-model-download" v-model="modelId" label="绘图模型" :options="modelOptions" :disabled="locked" />
          <div class="setup-budget"><span>最多下载<strong>{{ formatSetupBytes(downloadBytes) }}</strong></span><span>所需空间<strong>{{ formatSetupBytes(setupRequiredBytes) }}</strong></span></div>
        </div>
        <p v-if="!setupSpaceEnough" class="setup-error" role="status">空间不足，请更换存放位置或释放空间后重新检查。</p>
        <label v-if="!running" class="setup-consent"><input v-model="reviewed" type="checkbox" :disabled="locked || !currentPlan" /><span>同意下载、安装并启用原生引擎，接受 <a :href="selectedModel.licenseUrl" target="_blank" rel="noopener noreferrer" aria-label="Anima 非商业许可，在新窗口打开">Anima 非商业许可</a>。</span></label>
        <small v-if="!running" class="setup-hint">仅限非商业使用。安装时可能需要 Windows 授权；已有模型和环境会保留。</small>
      </template>
      <p v-if="pendingRestart" role="status">准备完成。重启后即可使用原生引擎。</p>
    </template>
    <p v-else role="status">{{ checking ? '正在检查设备与配置…' : '暂时无法读取配置，请重新检查。' }}</p>
    <div v-if="running" class="setup-progress" role="status" aria-live="polite">
      <div><strong>{{ operationTitle }}</strong><span v-if="progress !== null">下载 {{ progress }}%</span></div>
      <progress v-if="operation?.totalBytes" :value="operation.downloadedBytes ?? 0" :max="operation.totalBytes" aria-label="下载进度" />
      <p>{{ operation?.cancelAllowed === false ? '请在 Windows 安装器中继续或取消。' : operation?.message }}</p>
      <small v-if="operation?.totalBytes">{{ formatSetupBytes(operation.downloadedBytes ?? 0) }} / {{ formatSetupBytes(operation.totalBytes) }}</small>
    </div>
    <p v-if="error" class="setup-error" role="alert">{{ error }}</p>
    <p v-else-if="message && !running && !pendingRestart && !nativeEnabled" role="status">{{ message }}</p>
    <div ref="actions" class="setup-primary" tabindex="-1" role="group" aria-label="原生引擎操作">
      <RouterLink v-if="nativeEnabled" class="btn btn-primary" :to="{ path: '/prompt-builder', query: { preparedModel: modelId } }"><ArchiveIcon name="spark" />开始创作</RouterLink>
      <button v-else-if="desktop?.restartForSetup && (workspacePending || pendingRestart)" class="btn btn-primary" type="button" :disabled="locked" :aria-busy="restarting" @click="restart">{{ restarting ? '正在重启…' : '重启并继续' }}</button>
      <button v-else-if="operationUncertain" class="btn btn-primary" type="button" :disabled="checking" @click="reconcile">{{ checking ? '核对中…' : '继续核对进度' }}</button>
      <button v-else-if="plan?.supported && !workspacePending && !pendingRestart" class="btn btn-primary" type="button" :disabled="!canSetup" @click="prepareEngine"><ArchiveIcon name="download" />{{ busy ? '正在准备…' : operation?.status === 'failed' ? '继续准备' : '一键准备' }}</button>
      <button v-else class="btn btn-primary" type="button" :disabled="locked" @click="refreshPlan">{{ checking ? '检查中…' : '重新检查' }}</button>
      <button v-if="running" class="btn btn-quiet" type="button" :disabled="!canCancel" @click="cancel">{{ cancelState === 'pending' || cancelState === 'accepted' ? '正在取消…' : '取消准备' }}</button>
      <RouterLink v-else-if="plan && !plan.supported && !workspacePending" class="btn btn-quiet" :to="{ query: $route.query, hash: '#control-setup' }" @click="openOtherSetup">查看其他配置</RouterLink>
      <small v-if="running">可以离开此页，后台会继续准备。</small>
    </div>
    <details v-if="plan && !workspacePending" class="setup-details">
      <StudioDisclosureSummary>设备与下载详情</StudioDisclosureSummary>
      <div class="setup-detail-content">
        <section><h4>设备要求</h4><p>Windows x64 · NVIDIA Ampere 至 Blackwell · 12 GB 显存 · 驱动 572.61 以上 · 24 GiB 内存。</p><p>本机内存：{{ plan.hardware.ramBytes === null ? '未知' : formatSetupBytes(plan.hardware.ramBytes) }}。显卡驱动请通过厂商更新。</p><ul v-if="plan.reasons.length"><li v-for="reason in plan.reasons" :key="reason">{{ reason }}</li></ul><p v-if="plan.network">{{ plan.network.message }}</p></section>
        <section><h4>下载内容</h4><div class="setup-package"><strong>原生运行库</strong><span>{{ plan.runtime.installed ? '已就绪' : formatSetupBytes(plan.runtime.downloadBytes) }}</span><small>{{ plan.runtime.label }}</small></div><div v-if="selectedModel" class="setup-package"><strong>{{ modelName }}</strong><span>{{ selectedModel.installed ? '已就绪' : formatSetupBytes(selectedModel.downloadBytes) }}</span><small>transformer、编码器、VAE、tokenizer 与配置</small></div><p v-if="!plan.supported">首次下载最多 {{ formatSetupBytes(downloadBytes) }}，本次准备需 {{ formatSetupBytes(setupRequiredBytes) }} 可用空间。</p></section>
        <section><h4>来源与许可</h4><ul class="setup-sources"><li v-for="source in plan.runtime.sources" :key="source.url"><a :href="source.url" target="_blank" rel="noopener noreferrer" :aria-label="`${source.label}来源，在新窗口打开`">{{ sourceName(source.label) }}</a><a :href="source.licenseUrl" target="_blank" rel="noopener noreferrer" aria-label="运行库许可，在新窗口打开">许可</a></li></ul><p v-if="selectedModel"><a :href="selectedModel.sourceUrl" target="_blank" rel="noopener noreferrer" aria-label="模型来源，在新窗口打开">模型来源</a> · <a :href="selectedModel.licenseUrl" target="_blank" rel="noopener noreferrer" aria-label="模型许可，在新窗口打开">非商业许可</a></p><p v-if="selectedModel">固定版本：<code>{{ selectedModel.revision }}</code></p><p>官方文件逐项核对大小与 SHA-256。缺少 VC++ 运行库时，由你确认 Windows 授权。</p></section>
        <section><h4>存放位置</h4><dl class="setup-paths"><template v-for="item in resourcePaths" :key="item.label"><dt>{{ item.label }}</dt><dd><code>{{ item.value }}</code></dd></template></dl></section>
        <p v-if="plan.runtime.recoveryReady">已发现完整候选，继续准备会重新校验并启用，无需重新解包。</p><p v-else-if="plan.runtime.recoverableBytes">继续准备时可回收 {{ formatSetupBytes(plan.runtime.recoverableBytes) }} 未完成暂存，已计入空间预算。</p>
        <p>取消或中断后保留下载进度，重新准备可续传。仅支持完整原生模型；单文件权重暂不支持直接导入。</p>
      </div>
    </details>
    <details class="setup-details">
      <StudioDisclosureSummary>离线配置与模型导入</StudioDisclosureSummary>
      <div class="setup-detail-content">
        <section v-if="plan && !workspacePending"><h4>单项管理</h4><label class="setup-consent"><input v-model="reviewed" type="checkbox" :disabled="locked || !plan.supported" /><span>同意当前清单的下载、安装与许可。</span></label><div class="setup-actions"><button class="btn btn-ghost btn-sm" type="button" :disabled="!canInstall" @click="installRuntime">仅准备运行库</button><button class="btn btn-ghost btn-sm" type="button" :disabled="!canDownload" @click="downloadModel">仅准备模型</button><button class="btn btn-ghost btn-sm" type="button" :disabled="!canActivate || nativeEnabled" @click="activate">仅启用引擎</button></div></section>
        <section><h4>离线运行库</h4><p>使用已有可信 Python 和离线依赖。</p><div class="setup-fields"><div class="setup-field"><label for="native-base-python">Python 文件</label><input id="native-base-python" v-model="basePython" :disabled="locked" type="text" spellcheck="false" autocomplete="off" /></div><div class="setup-field"><label for="native-wheelhouse">wheelhouse 目录</label><input id="native-wheelhouse" v-model="wheelhouse" :disabled="locked" type="text" spellcheck="false" autocomplete="off" /></div></div><label class="setup-consent"><input v-model="runtimeReviewed" type="checkbox" :disabled="locked" />信任此 Python 与依赖的来源和许可。</label><div class="setup-actions"><button class="btn btn-ghost btn-sm" type="button" :disabled="!canPrepare" @click="prepare">准备离线运行库</button><button v-if="preparedPaths" class="btn btn-quiet btn-sm" type="button" :disabled="locked" @click="fillSettings">填入高级设置</button></div></section>
        <section><h4>已有模型</h4><p>导入配齐组件的 Anima Diffusers 目录；已有模型和 LoRA 也可在高级设置直接复用。</p><div class="setup-fields"><div class="setup-field"><label for="native-import-model">对应型号</label><StudioSelect id="native-import-model" v-model="importModelId" label="对应型号" :options="inferenceImportModels" :disabled="locked" /></div><div class="setup-field"><label for="native-import-source">来源目录</label><input id="native-import-source" v-model="sourceDir" :disabled="locked" type="text" spellcheck="false" autocomplete="off" /></div></div><button class="btn btn-ghost btn-sm" type="button" :disabled="!canInspect" @click="inspect">{{ inspecting ? '检查中…' : '查看导入计划' }}</button><div v-if="inspection" class="setup-import"><p>来源：<code>{{ inspection.sourceDir }}</code></p><p>目标：<code>{{ inspection.targetDir }}</code></p><p>{{ inspection.fileCount }} 个文件 · {{ formatSetupBytes(inspection.totalBytes) }}。复制到新目录，保留来源；仅检查目录布局，兼容性需加载确认。</p><label class="setup-consent"><input v-model="importReviewed" type="checkbox" :disabled="locked" />同意此模型的许可与复制计划。</label><button class="btn btn-ghost btn-sm" type="button" :disabled="!canImport" @click="importModel">导入模型</button></div></section>
      </div>
    </details>
    <CompanionWorkspaceSettings v-if="desktop" :open="workspaceOpen" v-model="workspaceDraft" :saving="workspaceSaving" :error="workspaceError" :return-focus-el="workspaceButton" @close="closeWorkspace" @save="saveWorkspace" />
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUpdate, onMounted, onUpdated, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import CompanionWorkspaceSettings from './CompanionWorkspaceSettings.vue'
import { useInferenceSetup } from '@/composables/useInferenceSetup'
import { inferenceImportModels, type PreparedInferencePaths } from '@/api/inferenceSetupApi'
import type { InferenceSettings } from '@/api/inferenceSettingsApi'
import { formatSetupBytes } from '@/utils/localSetupPreparation'
const props = defineProps<{ configured: InferenceSettings; blocked: boolean }>()
const emit = defineEmits<{ prepared: [paths: PreparedInferencePaths]; busy: [value: boolean]; activated: [] }>()
const { desktop, plan, selectedModel, currentPlan, nativeEnabled, reviewed, setupRequiredBytes, setupSpaceEnough, canSetup, canInstall, canDownload, canActivate,
  basePython, wheelhouse, runtimeReviewed, modelId, importModelId, sourceDir, importReviewed, inspection, inspecting, preparedPaths,
  operation, busy, checking, activating, restarting, locked, canPrepare, canInspect, canImport, canCancel, progress, message, error, cancelState, operationUncertain,
  workspaceOpen, workspaceDraft, workspaceSaving, workspacePending, workspaceButton, workspaceError,
  initialize, refreshPlan, prepareEngine, installRuntime, downloadModel, activate, prepare, inspect, importModel, cancel, reconcile,
  openWorkspace, closeWorkspace, saveWorkspace, openFolder, restart } = useInferenceSetup(computed(() => props.configured), computed(() => props.blocked), () => emit('activated'))
const modelOptions = computed(() => plan.value?.models.map(model => ({ value: model.id, label: model.label })) ?? [])
const modelName = computed(() => selectedModel.value?.label.split(' · ')[0] ?? 'Anima')
const running = computed(() => operation.value?.status === 'running')
const pendingRestart = computed(() => plan.value?.supported && plan.value.workspaceMatches && plan.value.configuredEngine === 'native' && plan.value.restartRequired && plan.value.runtime.installed && selectedModel.value?.installed)
const deviceName = computed(() => [...(plan.value?.hardware.devices ?? []), ...(plan.value?.hardware.otherDevices ?? [])].map(device => device.name).join('、') || '未检测到可用显卡')
const unavailableTitle = computed(() => plan.value?.freeBytes === null ? '先选择可用的存放位置' : '这台电脑暂不支持原生生图')
const unavailableHint = computed(() => {
  if (plan.value?.freeBytes === null) return '请选择可写且空间充足的文件夹。'
  if (/AMD|Intel/i.test(deviceName.value) && !plan.value?.hardware.devices.length) return '当前版本需要受支持的 NVIDIA 显卡。其他设备支持尚未接入。'
  return plan.value?.reasons[0] ?? '请查看设备要求，再重新检查。'
})
const downloadBytes = computed(() => (plan.value?.runtime.installed ? 0 : plan.value?.runtime.downloadBytes ?? 0) + (selectedModel.value?.installed ? 0 : selectedModel.value?.downloadBytes ?? 0))
const operationTitle = computed(() => operation.value?.flowStep === 'activate' || activating.value ? '校验并启用引擎' : operation.value?.flowStep === 'model' ? '准备绘图模型' : operation.value?.flowStep === 'runtime' ? '准备运行库' : operation.value?.stages[operation.value.stageIndex] ?? '正在准备')
const resourcePaths = computed(() => plan.value ? [
  { label: '运行库', value: plan.value.paths.runtimeRoot }, { label: '底模', value: plan.value.paths.modelsRoot },
  { label: 'LoRA', value: plan.value.paths.lorasRoot }, { label: '下载缓存', value: plan.value.paths.cacheRoot }, { label: '临时文件', value: plan.value.paths.tempRoot },
] : [])
function sourceName(label: string) { return label.startsWith('Python') ? 'Python.org' : label.startsWith('PyTorch') ? 'PyTorch' : label.startsWith('PyPI') ? 'PyPI' : label.startsWith('Microsoft') ? 'Microsoft VC++' : label.startsWith('NVIDIA') ? 'NVIDIA CUDA' : label }
function fillSettings() { if (preparedPaths.value && !locked.value) emit('prepared', { ...preparedPaths.value }) }
function openOtherSetup() { const section = document.getElementById('control-setup'); if (section instanceof HTMLDetailsElement) section.open = true }
const route = useRoute()
const panel = ref<HTMLElement | null>(null), title = ref<HTMLElement | null>(null), actions = ref<HTMLElement | null>(null)
let focusOrigin: HTMLButtonElement | null = null
let focusHost: HTMLElement | null = null
function visible(element: HTMLElement | null) {
  if (!element?.isConnected || element.closest('[hidden], [inert], [aria-hidden="true"]') || getComputedStyle(element).visibility === 'hidden') return false
  const bounds = element.getBoundingClientRect()
  return bounds.width > 0 && bounds.height > 0 && bounds.bottom > 0 && bounds.top < innerHeight
}
onBeforeUpdate(() => {
  const active = document.activeElement
  focusOrigin = active instanceof HTMLButtonElement && panel.value?.contains(active) && visible(active) ? active : null
  focusHost = focusOrigin?.closest<HTMLElement>('.setup-primary') ?? title.value
})
onUpdated(() => {
  const origin = focusOrigin, host = focusHost
  focusOrigin = null; focusHost = null
  if (!origin || origin.isConnected && !origin.disabled || route.path !== '/control' || !document.hasFocus() || !visible(panel.value)) return
  if (document.activeElement !== document.body && document.activeElement !== origin) return
  if ([...document.querySelectorAll<HTMLElement>('dialog:modal, [aria-modal="true"]')].some(element =>
    element.getClientRects().length && !element.closest('[hidden], [aria-hidden="true"]') && getComputedStyle(element).visibility !== 'hidden')) return
  ;[host, actions.value, title.value].find(visible)?.focus({ preventScroll: true })
})
watch([busy, checking, inspecting, activating, restarting, workspaceSaving, operationUncertain], () => emit('busy', busy.value || checking.value || inspecting.value || activating.value || restarting.value || workspaceSaving.value || operationUncertain.value), { immediate: true })
onMounted(initialize)
</script>

<style scoped>
.inference-setup { display:grid; gap:var(--s-4); margin-top:var(--s-5); }
.setup-intro { display:flex; align-items:center; gap:var(--s-3); }
.setup-mark { display:grid; place-items:center; width:48px; height:48px; flex-shrink:0; border:1px solid var(--border-soft); border-radius:var(--r-lg); background:var(--bg-elevated); color:var(--accent); }
.setup-mark .archive-icon { width:24px; height:24px; }
.inference-setup h3, .inference-setup h4, .inference-setup p { margin:0; }
.inference-setup h3 { font-size:var(--fs-title-sm); }
.inference-setup p, .inference-setup li, .inference-setup small { color:var(--text-secondary); line-height:var(--lh-body); overflow-wrap:anywhere; }
.setup-label { color:var(--text-secondary); font-size:var(--fs-label-sm); }
.setup-route { display:flex; flex-wrap:wrap; gap:var(--s-5); padding:0; margin:0; list-style:none; }
.setup-route li { display:flex; align-items:center; gap:var(--s-2); font-size:var(--fs-label-sm); }
.setup-route li > span { display:grid; place-items:center; width:24px; height:24px; border:1px solid var(--border-soft); border-radius:var(--r-pill); color:var(--text-secondary); }
.setup-route li[data-ready="true"] > span { border-color:var(--success-text); color:var(--success-text); }
.setup-location { display:flex; align-items:center; gap:var(--s-3); padding-block:var(--s-4); border-block:1px solid var(--border-soft); }
.setup-location > .archive-icon { flex-shrink:0; color:var(--text-secondary); }
.setup-location > div:first-of-type { display:grid; gap:var(--s-1); min-width:0; flex:1; }
code { color:var(--text-primary); font-size:var(--fs-label-sm); overflow-wrap:anywhere; }
.setup-actions, .setup-primary { display:flex; align-items:center; flex-wrap:wrap; gap:var(--s-3); }
.setup-status { display:flex; align-items:flex-start; gap:var(--s-3); padding:var(--s-4); border-radius:var(--r-lg); background:var(--bg-elevated); }
.setup-status > .archive-icon { color:var(--text-secondary); flex-shrink:0; }
.setup-status[data-state="ready"] > .archive-icon, .setup-status[data-state="available"] > .archive-icon { color:var(--success-text); }
.setup-status > div { display:grid; gap:var(--s-1); flex:1; min-width:0; }
.setup-status strong, .setup-model strong { color:var(--text-primary); }
.setup-model { display:flex; align-items:center; gap:var(--s-4); flex-wrap:wrap; }
.setup-model-copy { display:flex; align-items:center; gap:var(--s-3); flex:1; }
.setup-model-copy > div { display:grid; gap:var(--s-1); }
.setup-model-copy .archive-icon { color:var(--text-secondary); }
.setup-budget { display:flex; gap:var(--s-5); }
.setup-budget > span { display:grid; gap:var(--s-1); color:var(--text-secondary); font-size:var(--fs-label-sm); }
.setup-budget strong { color:var(--text-primary); font-size:var(--fs-body); font-variant-numeric:tabular-nums; }
.setup-consent { display:flex; align-items:flex-start; gap:var(--s-2); color:var(--text-primary); line-height:var(--lh-body); }
.setup-consent input { flex-shrink:0; margin-top:var(--s-1); }
.setup-hint { margin-top:calc(-1 * var(--s-2)); }
.setup-primary { min-height:var(--control-height); padding-bottom:var(--s-2); }
.setup-primary > .btn-primary { min-width:160px; }
.setup-progress { display:grid; gap:var(--s-2); }
.setup-progress > div { display:flex; align-items:center; justify-content:space-between; }
.setup-progress progress { width:100%; }
.setup-details { border-top:1px solid var(--border-soft); padding-top:var(--s-2); }
.setup-detail-content, .setup-detail-content section, .setup-import { display:grid; gap:var(--s-3); }
.setup-detail-content { padding-block:var(--s-4); }
.setup-detail-content section + section { border-top:1px solid var(--border-soft); padding-top:var(--s-4); }
.setup-package { display:grid; grid-template-columns:1fr auto; gap:var(--s-1) var(--s-3); }
.setup-package small { grid-column:1 / -1; }
.setup-sources { list-style:none; display:grid; gap:var(--s-2); padding:0; margin:0; }
.setup-sources li { display:flex; justify-content:space-between; gap:var(--s-3); }
.setup-paths { display:grid; grid-template-columns:max-content minmax(0,1fr); gap:var(--s-2) var(--s-4); margin:0; }
.setup-paths dt { color:var(--text-secondary); }
.setup-paths dd { margin:0; min-width:0; }
.setup-fields { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:var(--s-4); }
.setup-field { display:grid; gap:var(--s-2); min-width:0; }
.setup-field input { box-sizing:border-box; width:100%; min-width:0; min-height:var(--control-height); padding:var(--s-3); border:1px solid var(--border-soft); border-radius:var(--r-md); background:var(--bg-surface); color:var(--text-primary); font:inherit; }
.inference-setup .setup-error { color:var(--danger-text); }
.inference-setup :is(input,button):disabled { color:var(--text-disabled); }
.inference-setup :is(input,button,summary,a,#native-setup-title,.setup-primary):focus-visible { outline:none; box-shadow:var(--focus-shadow); }
.inference-setup a:not(.btn) { color:var(--accent); text-decoration:underline; text-underline-offset:3px; }
@media(forced-colors:active) { .inference-setup :is(#native-setup-title,.setup-primary):focus-visible { outline:2px solid Highlight; outline-offset:2px; } }
@media(max-width:768px) { .setup-fields, .setup-paths { grid-template-columns:minmax(0,1fr); } .setup-status { flex-wrap:wrap; } .setup-location { align-items:flex-start; flex-wrap:wrap; } .setup-budget { width:100%; } }
</style>
