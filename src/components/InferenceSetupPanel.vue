<template>
  <section ref="panel" class="inference-setup" aria-labelledby="native-setup-title">
    <div class="setup-intro">
      <span class="setup-mark"><ArchiveIcon name="spark" /></span>
      <div><h3 id="native-setup-title" ref="title" tabindex="-1">{{ videoRequested || isVideo ? '准备本机视频' : '准备本机模型' }}</h3><p>选择工作区和模型，准备完成后即可启用原生引擎。</p></div>
    </div>
    <ol class="setup-route" aria-label="配置流程">
      <li :aria-current="!workspacePending && !pendingRestart && !nativeEnabled ? 'step' : undefined"><span>1</span>准备模型</li>
      <li :aria-current="pendingRestart || workspacePending ? 'step' : undefined"><span>2</span>启用引擎</li>
      <li :aria-current="nativeEnabled ? 'step' : undefined"><span>3</span>{{ isVideo || videoRequested ? '进入故事短片' : '进入画室' }}</li>
    </ol>
    <div class="setup-location">
      <ArchiveIcon name="folder" />
      <div>
        <span class="setup-label">存放位置</span>
        <code>{{ workspaceDraft || plan?.workspacePath || '正在读取…' }}</code>
        <small v-if="!workspacePending && plan?.freeBytes !== null && plan?.freeBytes !== undefined">可用 {{ formatSetupBytes(plan.freeBytes) }}</small>
        <small v-if="workspaceOnCDrive && !nativeEnabled && setupRequiredBytes > 0">当前位于 C 盘，本次准备需 {{ formatSetupBytes(setupRequiredBytes) }} 可用空间。</small>
      </div>
      <div class="setup-actions"><button v-if="desktop" ref="workspaceButton" class="btn btn-ghost btn-sm" type="button" :disabled="locked" @click="openWorkspace">更换位置</button><button v-if="desktop && plan && !workspacePending" class="btn btn-quiet btn-sm" type="button" @click="openFolder">打开文件夹</button></div>
    </div>
    <p v-if="workspaceError" class="setup-error" role="alert">{{ workspaceError }}</p>
    <div v-if="workspacePending" class="setup-status" role="status"><ArchiveIcon name="info" /><div><strong>存放位置已更改</strong><p>重启绘遇后，在新目录继续准备。已有文件会保留。</p></div></div>
    <template v-else-if="plan">
      <div class="setup-field setup-model-choice">
        <label for="native-model-download">{{ modelLabel }}</label>
        <StudioSelect id="native-model-download" :model-value="modelId" :label="modelLabel" :options="modelOptions" :disabled="locked" @update:model-value="chooseModel" />
        <small v-if="plan.supported && modelId === 'anima-miaomiao-v1.6'">入门推荐 · 可自动下载权重</small>
      </div>
      <div class="setup-status" :data-state="nativeEnabled ? 'ready' : plan.supported ? 'available' : 'unavailable'" role="status">
        <ArchiveIcon :name="plan.supported ? 'success' : 'info'" />
        <div><strong>{{ nativeEnabled ? '原生引擎和模型已就绪' : plan.supported ? '可以自动准备' : unavailableTitle }}</strong><p>{{ deviceName }}</p><p v-if="!plan.supported">{{ unavailableHint }}</p></div>
        <button v-if="plan.supported" class="btn btn-quiet btn-sm" type="button" :disabled="locked" @click="recheck">重新检查</button>
      </div>
      <template v-if="selectedModel && (plan.supported || videoDownloadOnly && !selectedModel.installed) && !nativeEnabled && !pendingRestart">
        <p v-if="selectedModel.preparation === 'moss-checkpoint' && !selectedModel.installed && !running" class="setup-hint">绘遇会先下载作者权重，再补齐编码器和 VAE，并自动适配原生格式。若 Civitai 要求登录，请从作者发布页下载对应文件，再使用下方的本地权重入口。</p>
        <details v-if="selectedModel.checkpointFilename && !selectedModel.installed && !running" class="setup-details" :open="!selectedModel.checkpointOptional">
          <StudioDisclosureSummary>使用已下载的权重{{ selectedModel.checkpointOptional ? '（可选）' : '' }}</StudioDisclosureSummary>
          <div class="setup-field" data-disclosure-content>
          <label for="author-checkpoint-path">已下载的作者权重{{ selectedModel.checkpointOptional ? '（可选）' : '' }}</label>
          <input id="author-checkpoint-path" v-model="checkpointPath" class="input" :disabled="locked" :placeholder="`例如 D:\\Models\\${selectedModel.checkpointFilename}`" spellcheck="false" aria-describedby="author-checkpoint-hint" />
          <small id="author-checkpoint-hint"><a :href="selectedModel.sourceUrl" target="_blank" rel="noopener noreferrer">作者发布页</a> · {{ selectedModel.checkpointFilename }} · {{ selectedModel.preparation === 'complete-model' ? '选择原始完整权重' : '使用该版本的完整权重' }}</small>
          </div>
        </details>
        <div class="setup-model">
          <div class="setup-model-copy"><ArchiveIcon name="model" /><div><span class="setup-label">{{ modelLabel }}</span><strong>{{ modelName }}</strong><small>{{ modelPreparationLabel }}</small></div></div>
          <div class="setup-budget"><span>最多下载<strong>{{ formatSetupBytes(videoDownloadOnly ? selectedModel.downloadBytes : downloadBytes) }}</strong></span><span>所需空间<strong>{{ formatSetupBytes(videoDownloadOnly ? modelRequiredBytes : setupRequiredBytes) }}</strong></span></div>
        </div>
        <p v-if="!(videoDownloadOnly ? modelSpaceEnough : setupSpaceEnough)" class="setup-error" role="status">空间不足，请更换存放位置或释放空间后重新检查。</p>
        <div v-if="selectedModel.requiresAccess && !selectedModel.installed && !running" class="setup-field">
          <label for="native-hf-token">Hugging Face 只读访问令牌</label>
          <input id="native-hf-token" v-model="hfToken" class="input" type="password" :disabled="locked" autocomplete="off" spellcheck="false" maxlength="512" aria-describedby="native-hf-token-hint" />
          <small id="native-hf-token-hint">先在 <a :href="selectedModel.sourceUrl" target="_blank" rel="noopener noreferrer">模型页面</a>接受许可并取得访问权，再填写该模型的只读令牌。仅用于本次 Hugging Face 下载，不保存到配置；完整缓存可离线继续。</small>
        </div>
        <label v-if="!running" class="setup-consent"><input v-model="reviewed" type="checkbox" :disabled="locked || !currentPlan" /><span>{{ selectedModel.localVideoImport ? '同意导入本机权重并接受' : videoDownloadOnly ? '同意下载模型并接受' : '同意安装并接受' }}<a :href="selectedModel.licenseUrl" target="_blank" rel="noopener noreferrer" aria-label="所选模型许可，在新窗口打开">模型许可</a></span></label>
        <small v-if="!running" class="setup-hint">{{ selectedModel.license }} · 已有文件保留</small>
      </template>
      <p v-if="selectedModel?.localWeights" role="status">已识别由本机权重准备的原生模型。</p>
      <p v-if="videoDownloadOnly && selectedModel?.installed" role="status">模型文件已就绪。在高级路径设置中选择兼容的适配器 Python，模型根目录填写 <code>{{ plan.paths.modelsRoot }}</code>。</p>
      <p v-if="isVideo" class="setup-hint">导出 MP4 需要带 libx264 的 ffmpeg。H3 和 LTX 的音轨还需要 AAC。请将 ffmpeg 加入 PATH，或用 HUIYU_NATIVE_FFMPEG 指定位置。</p>
      <p v-if="isVideo && plan.supported && !plan.workspaceMatches" class="setup-hint">启用后，图像与视频适配器共用此工作区的模型根目录和适配器 Python。</p>
      <p v-if="pendingRestart" role="status">模型与运行库已准备好，重启绘遇后生效。</p>
    </template>
    <p v-else role="status">{{ checking ? '正在检查设备与配置…' : '暂时无法读取配置，请重新检查。' }}</p>
    <SetupTransferProgress v-if="running" :title="operationTitle" :phase="operationPhase"
      :scope="operationPhase === 'converting' ? 'conversion' : 'manifest'"
      :received="operationPhase === 'converting' ? operation?.workDone : operation?.downloadedBytes"
      :total="operationPhase === 'converting' ? operation?.workTotal : operation?.totalBytes" :current-file="operation?.currentFile"
      :message="operation?.message">
      <small v-if="operation?.cancelAllowed === false">{{ operation.phase === 'activating' ? '正在启用配置，请等待完成。' : '系统安装步骤请在 Windows 安装器中继续或取消。' }}</small>
    </SetupTransferProgress>
    <p v-if="error" class="setup-error" role="alert">{{ error }}</p>
    <p v-else-if="message && !running && !pendingRestart && !nativeEnabled" role="status">{{ message }}</p>
    <div ref="actions" class="setup-primary" tabindex="-1" role="group" aria-label="原生引擎操作">
      <RouterLink v-if="nativeEnabled && selectedModel?.family === 'video' && !locked" class="btn btn-primary" :to="videoDestination"><ArchiveIcon name="spark" />进入故事短片</RouterLink>
      <RouterLink v-else-if="nativeEnabled && selectedModel && selectedModel.family !== 'video' && !locked" class="btn btn-primary" :to="firstDrawingRoute(modelId, selectedModel.family)"><ArchiveIcon name="spark" />去画室生成第一张图</RouterLink>
      <button v-else-if="desktop?.restartForSetup && !operationUncertain && (workspacePending || pendingRestart)" class="btn btn-primary" type="button" :disabled="locked" :aria-busy="restarting" @click="restart">{{ restarting ? '正在重启…' : '重启并继续' }}</button>
      <button v-else-if="operationUncertain" class="btn btn-primary" type="button" :disabled="checking" @click="reconcile">{{ checking ? '核对中…' : '继续核对进度' }}</button>
      <button v-else-if="plan?.supported && !workspacePending && !pendingRestart" class="btn btn-primary" type="button" :disabled="!canSetup" :aria-describedby="setupBlockerReason ? setupBlockerId : undefined" @click="prepareEngine"><ArchiveIcon name="download" />{{ prepareLabel }}</button>
      <button v-else-if="videoDownloadOnly && !workspacePending && !selectedModel?.installed" class="btn btn-primary" type="button" :disabled="!canDownload" @click="downloadModel"><ArchiveIcon name="download" />{{ selectedModel?.localVideoImport ? '导入本机视频权重' : '仅下载视频模型' }}</button>
      <button v-else class="btn btn-primary" type="button" :disabled="locked" @click="recheck">{{ checking ? '检查中…' : '重新检查' }}</button>
      <button v-if="running" class="btn btn-quiet" type="button" :disabled="!canCancel" @click="cancel">{{ cancelState === 'pending' || cancelState === 'accepted' ? '正在取消…' : '取消准备' }}</button>
      <template v-if="!running && !workspacePending && !nativeEnabled">
        <RouterLink v-if="!isVideo" class="btn btn-quiet" to="/control#control-remote">连接另一台绘遇</RouterLink>
        <RouterLink v-if="plan && !plan.supported" class="btn btn-quiet" to="/control#control-comfy">使用 ComfyUI</RouterLink>
      </template>
    </div>
    <p v-if="setupBlockerReason" :id="setupBlockerId" class="setup-hint" role="status">{{ setupBlockerReason }}</p>
    <details v-if="plan && !workspacePending && !isVideo" id="control-image-resources" class="setup-details" :open="typeof route.query.resource === 'string' || route.hash === '#control-image-resources'">
      <StudioDisclosureSummary><span>添加更多绘图能力<small class="setup-disclosure-hint">自动蒙版、高清放大、草图与角色 LoRA · 按需下载</small></span></StudioDisclosureSummary>
      <div class="setup-detail-content">
        <section>
          <p>按需准备自动蒙版、高清放大、草图、漫画线稿与 LoRA。无需安装或启动 ComfyUI。</p>
          <div class="setup-field"><label for="native-resource">选择资源</label><StudioSelect id="native-resource" v-model="resourceId" label="辅助模型与 LoRA" :options="resourceOptions" :disabled="locked" /></div>
          <template v-if="selectedResource">
            <p>{{ selectedResource.description }}</p>
            <p>{{ selectedResource.present ? '已发现全部文件；再次准备会核对完整摘要。' : `最多下载 ${formatSetupBytes(selectedResource.downloadBytes)} · ${selectedResource.fileCount} 个文件` }}</p>
            <p v-if="selectedResource.freeBytes !== null">所需空间 {{ formatSetupBytes(selectedResource.requiredBytes) }} · 目标磁盘可用 {{ formatSetupBytes(selectedResource.freeBytes) }}</p>
            <p>保存到：<code>{{ selectedResource.path }}</code></p>
            <p v-if="selectedResource.directory === 'models'">辅助模型使用已配置的模型目录，不会更改底模位置。</p>
            <label class="setup-consent"><input v-model="resourceReviewed" type="checkbox" :disabled="locked" /><span>已核对<a :href="selectedResource.sourceUrl" target="_blank" rel="noopener noreferrer">下载来源</a>并接受<a :href="selectedResource.licenseUrl" target="_blank" rel="noopener noreferrer">资源许可</a>，同意下载所选资源。</span></label>
            <p v-if="selectedResource.prepareError" class="setup-error" role="status">{{ selectedResource.prepareError }}</p>
            <p v-else-if="selectedResource.freeBytes !== null && selectedResource.freeBytes < selectedResource.requiredBytes" role="status">下载和校验所需空间不足。</p>
            <div class="setup-actions"><button class="btn btn-ghost btn-sm" type="button" :disabled="!canDownloadResource" @click="downloadResource">{{ selectedResource.present ? '校验并补齐资源' : '准备所选资源' }}</button><button v-if="selectedResource.directory === 'loras' && configured.lorasRoot !== plan.paths.lorasRoot" class="btn btn-quiet btn-sm" type="button" :disabled="locked" @click="fillResourcePaths">采用原生 LoRA 目录</button></div>
            <p v-if="selectedResource.directory === 'loras' && configured.lorasRoot !== plan.paths.lorasRoot">当前仍使用其他 LoRA 目录。采用后需保存设置并重启；原目录文件会保留。</p>
            <p v-if="operation?.kind === 'download-native-resource' && !running && message" role="status">{{ message }}</p>
            <small>需要账号授权的来源请自行下载到所示目录后校验。已有不同文件不会被覆盖；取消保留进度。文件校验不代表实际生成已验收。</small>
          </template>
        </section>
      </div>
    </details>
    <details v-if="plan && !workspacePending" class="setup-details">
      <StudioDisclosureSummary>设备与下载详情</StudioDisclosureSummary>
      <div class="setup-detail-content">
        <p v-for="warning in plan.warnings" :key="warning" class="setup-hint">{{ warning }}</p>
        <section><h4>设备要求</h4><p>Windows x64 · NVIDIA Ampere 至 Blackwell · 驱动 572.61 以上。默认分层卸载，显存与系统内存容量作为提醒，实际可用画幅和模型需在设备上确认。</p><p>本机内存：{{ plan.hardware.ramBytes === null ? '未知' : formatSetupBytes(plan.hardware.ramBytes) }}。显卡驱动请通过厂商更新。</p><ul v-if="plan.reasons.length"><li v-for="reason in plan.reasons" :key="reason">{{ reason }}</li></ul></section>
        <section><h4>下载内容</h4><div class="setup-package"><strong>原生运行库</strong><span>{{ plan.runtime.installed ? '已就绪' : formatSetupBytes(plan.runtime.downloadBytes) }}</span><small>{{ plan.runtime.label }}</small></div><div v-if="selectedModel" class="setup-package"><strong>{{ modelName }}</strong><span>{{ selectedModel.installed ? '已就绪' : formatSetupBytes(selectedModel.downloadBytes) }}</span><small>transformer、编码器、VAE、tokenizer 与配置</small></div><p v-if="!plan.supported && !videoDownloadOnly">首次下载最多 {{ formatSetupBytes(downloadBytes) }}，本次准备需 {{ formatSetupBytes(setupRequiredBytes) }} 可用空间。</p></section>
        <section><h4>来源与许可</h4><ul class="setup-sources"><li v-for="source in plan.runtime.sources" :key="source.url"><a :href="source.url" target="_blank" rel="noopener noreferrer" :aria-label="`${source.label}来源，在新窗口打开`">{{ sourceName(source.label) }}</a><a :href="source.licenseUrl" target="_blank" rel="noopener noreferrer" aria-label="运行库许可，在新窗口打开">许可</a></li></ul><p v-if="selectedModel"><a :href="selectedModel.sourceUrl" target="_blank" rel="noopener noreferrer" aria-label="模型来源，在新窗口打开">模型来源</a> · <a :href="selectedModel.licenseUrl" target="_blank" rel="noopener noreferrer" aria-label="模型许可，在新窗口打开">模型许可</a></p><p v-if="selectedModel">{{ selectedModel.localWeights || selectedModel.localVideoImport ? '兼容的原生配置版本' : '固定版本' }}：<code>{{ selectedModel.revision }}</code></p><p>官方文件逐项核对固定版本与 SHA-256。Krea 需先授权取得文件清单。缺少 VC++ 运行库时，由你确认 Windows 授权。</p></section>
        <section><h4>存放位置</h4><dl class="setup-paths"><template v-for="item in resourcePaths" :key="item.label"><dt>{{ item.label }}</dt><dd><code>{{ item.value }}</code></dd></template></dl></section>
        <p v-if="plan.runtime.recoveryReady">已发现完整候选，继续准备会直接采用，无需重新解包。</p>
        <p>中断后可继续下载，已校验的文件可复用。</p>
      </div>
    </details>
    <details v-if="!videoDownloadOnly" class="setup-details">
      <StudioDisclosureSummary>{{ isVideo ? '单独准备或启用' : '离线配置与模型导入' }}</StudioDisclosureSummary>
      <div class="setup-detail-content">
        <section v-if="plan && !workspacePending"><h4>单项管理</h4><label class="setup-consent"><input v-model="reviewed" type="checkbox" :disabled="locked || !plan.supported" /><span>同意当前清单的下载、安装与许可。</span></label><div class="setup-actions"><button class="btn btn-ghost btn-sm" type="button" :disabled="!canInstall" @click="installRuntime">仅准备运行库</button><button class="btn btn-ghost btn-sm" type="button" :disabled="!canDownload" @click="downloadModel">仅准备模型</button><button class="btn btn-ghost btn-sm" type="button" :disabled="!canActivate || nativeEnabled" @click="activate">仅启用引擎</button></div></section>
        <section v-if="!isVideo"><h4>离线运行库</h4><p>使用已有可信 Python 和离线依赖。</p><div class="setup-fields"><div class="setup-field"><label for="native-base-python">Python 文件</label><input id="native-base-python" class="input" v-model="basePython" :disabled="locked" type="text" spellcheck="false" autocomplete="off" /></div><div class="setup-field"><label for="native-wheelhouse">wheelhouse 目录</label><input id="native-wheelhouse" class="input" v-model="wheelhouse" :disabled="locked" type="text" spellcheck="false" autocomplete="off" /></div></div><label class="setup-consent"><input v-model="runtimeReviewed" type="checkbox" :disabled="locked" />信任此 Python 与依赖的来源和许可。</label><div class="setup-actions"><button class="btn btn-ghost btn-sm" type="button" :disabled="!canPrepare" @click="prepare">准备离线运行库</button><button v-if="preparedPaths" class="btn btn-quiet btn-sm" type="button" :disabled="locked" @click="fillSettings">填入高级设置</button></div></section>
        <section v-if="!isVideo"><h4>已有模型</h4><p>导入配齐组件的 Anima Diffusers 目录；已有模型和 LoRA 也可在高级设置直接复用。</p><div class="setup-fields"><div class="setup-field"><label for="native-import-model">对应型号</label><StudioSelect id="native-import-model" v-model="importModelId" label="对应型号" :options="inferenceImportModels" :disabled="locked" /></div><div class="setup-field"><label for="native-import-source">来源目录</label><input id="native-import-source" class="input" v-model="sourceDir" :disabled="locked" type="text" spellcheck="false" autocomplete="off" /></div></div><button class="btn btn-ghost btn-sm" type="button" :disabled="!canInspect" @click="inspect">{{ inspecting ? '检查中…' : '查看导入计划' }}</button><div v-if="inspection" class="setup-import"><p>来源：<code>{{ inspection.sourceDir }}</code></p><p>目标：<code>{{ inspection.targetDir }}</code></p><p>{{ inspection.fileCount }} 个文件 · {{ formatSetupBytes(inspection.totalBytes) }}。复制到新目录，保留来源；仅检查目录布局，兼容性需加载确认。</p><label class="setup-consent"><input v-model="importReviewed" type="checkbox" :disabled="locked" />同意此模型的许可与复制计划。</label><button class="btn btn-ghost btn-sm" type="button" :disabled="!canImport" @click="importModel">导入模型</button></div></section>
      </div>
    </details>
    <CompanionWorkspaceSettings v-if="desktop" :open="workspaceOpen" v-model="workspaceDraft" :saving="workspaceSaving" :error="workspaceError" :return-focus-el="workspaceButton" @close="closeWorkspace" @save="saveWorkspace" />
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUpdate, onMounted, onUpdated, ref, useId, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import SetupTransferProgress from '@/components/control/SetupTransferProgress.vue'
import { setupTransferPhase } from '@/utils/setupOperationProgress'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import CompanionWorkspaceSettings from './CompanionWorkspaceSettings.vue'
import { useInferenceSetup } from '@/composables/useInferenceSetup'
import { inferenceImportModels, type PreparedInferencePaths } from '@/api/inferenceSetupApi'
import type { InferenceSettings } from '@/api/inferenceSettingsApi'
import { formatSetupBytes } from '@/utils/localSetupPreparation'
import { videoReturnLocation } from '@/utils/videoNavigation'
import { firstDrawingRoute } from '@/utils/setupDrawingRoute'
const props = defineProps<{ configured: InferenceSettings; blocked: boolean }>()
const emit = defineEmits<{ prepared: [paths: PreparedInferencePaths]; busy: [value: boolean]; working: [value: boolean]; activated: [] }>()
const route = useRoute()
const videoRequested = computed(() => route.query.videoSetup === '1')
const modelLabel = computed(() => videoRequested.value ? '视频模型' : '本机模型')
const requestedModel = computed(() => typeof route.query.model === 'string' ? route.query.model : '')
const { resourceId, resourceReviewed, selectedResource, canDownloadResource, downloadResource, checkpointPath, hfToken, selectModel, desktop, plan, selectedModel, currentPlan, nativeEnabled, reviewed, setupRequiredBytes, setupSpaceEnough, modelRequiredBytes, modelSpaceEnough, canSetup, canInstall, canDownload, canActivate,
  basePython, wheelhouse, runtimeReviewed, modelId, importModelId, sourceDir, importReviewed, inspection, inspecting, preparedPaths,
  operation, busy, checking, activating, restarting, locked, canPrepare, canInspect, canImport, canCancel, message, error, cancelState, operationUncertain,
  workspaceOpen, workspaceDraft, workspaceSaving, workspacePending, workspaceButton, workspaceError,
  recheck, prepareEngine, installRuntime, downloadModel, activate, prepare, inspect, importModel, cancel, reconcile,
  openWorkspace, closeWorkspace, saveWorkspace, openFolder, restart } = useInferenceSetup(computed(() => props.configured), computed(() => props.blocked), () => emit('activated'), requestedModel, videoRequested)
const workspaceOnCDrive = computed(() => /^c:[\\/]/i.test((workspaceDraft.value || plan.value?.workspacePath || '').trim()))
const setupBlockerId = useId()
const setupBlockerReason = computed(() => {
  if (!plan.value?.supported || workspacePending.value || pendingRestart.value || canSetup.value || running.value) return ''
  if (locked.value || props.blocked) return '正在处理配置或等待其他操作完成。'
  if (selectedModel.value?.requiresAccess && !selectedModel.value?.installed && !hfToken.value.trim()) return '请先在上方填写 Hugging Face 只读访问令牌。'
  if (!(videoDownloadOnly.value ? modelSpaceEnough.value : setupSpaceEnough.value)) return '当前磁盘可用空间不足，请更换存放位置或清理磁盘空间。'
  if (!reviewed.value) return '请先勾选上方「同意安装并接受模型许可」复选框后再开始。'
  return '当前条件尚未满足，请检查上方配置后点击「重新检查」。'
})
const isVideo = computed(() => selectedModel.value?.family === 'video')
const videoDownloadOnly = computed(() => isVideo.value && !!plan.value && !plan.value.supported && plan.value.freeBytes !== null)
const videoDestination = computed(() => {
  const target = videoReturnLocation(route.query)
  return { ...target, query: { ...target.query, preparedModel: modelId.value } }
})
const modelOptions = computed(() => plan.value?.models.filter(model => !videoRequested.value || model.family === 'video').map(model => ({ value: model.id, label: model.label })) ?? [])
const resourceOptions = computed(() => plan.value?.resources.map(value => ({ value: value.id, label: value.label })) ?? [])
function fillResourcePaths() {
  if (plan.value && !locked.value) emit('prepared', { python: props.configured.python, worker: props.configured.worker,
    modelsRoot: props.configured.modelsRoot, lorasRoot: plan.value.paths.lorasRoot })
}
const modelName = computed(() => selectedModel.value?.label.split(' · ')[0] ?? 'Anima')
const modelPreparationLabel = computed(() => {
  if (selectedModel.value?.localVideoImport) return selectedModel.value.downloadBytes
    ? '复用本机 ComfyUI 权重，补齐分词器与配置' : '从本机 ComfyUI 权重转换，支持离线准备'
  if (selectedModel.value?.preparation === 'moss-checkpoint') return selectedModel.value.id === 'moss-miaomiao-base-v1.1'
    ? '作者 INT8 权重与 INT8 文本编码器' : '作者 FP16 权重与 BF16 文本编码器'
  return selectedModel.value?.preparation === 'checkpoint-conversion' ? '下载原始权重，自动转换为原生模型' : '完整原生模型'
})
const running = computed(() => operation.value?.status === 'running')
const pendingRestart = computed(() => plan.value?.supported && plan.value.workspaceMatches && plan.value.configuredEngine === 'native' && plan.value.restartRequired && plan.value.runtime.installed && selectedModel.value?.installed)
const deviceName = computed(() => [...(plan.value?.hardware.devices ?? []), ...(plan.value?.hardware.otherDevices ?? [])].map(device => device.name).join('、') || '未检测到可用显卡')
const unavailableTitle = computed(() => plan.value?.freeBytes === null ? '先选择可用的存放位置' : '当前无法一键安装本机环境')
const unavailableHint = computed(() => {
  if (plan.value?.freeBytes === null) return '请选择可写且空间充足的文件夹。'
  if (selectedModel.value?.id === 'longcat-avatar-1.6') return plan.value?.reasons[0]
  if (videoDownloadOnly.value) return selectedModel.value?.localVideoImport ? '可先从本机权重导入模型，再在高级设置中选择兼容的运行环境。' : '可单独下载视频模型，再在高级路径设置中选择兼容的适配器 Python。'
  if (/AMD|Intel|Radeon/i.test(deviceName.value) && !plan.value?.hardware.devices.length) return '自动安装使用受支持的 NVIDIA 显卡。可连接另一台绘遇，或在高级设置复用配好的 Anima 环境。'
  return plan.value?.reasons[0] ?? '请查看设备要求，再重新检查。'
})
const downloadBytes = computed(() => (plan.value?.runtime.installed ? 0 : plan.value?.runtime.downloadBytes ?? 0) + (selectedModel.value?.installed ? 0 : selectedModel.value?.downloadBytes ?? 0))
const operationTitle = computed(() => operation.value?.flowStep === 'activate' || activating.value ? '校验并启用引擎' : operation.value?.flowStep === 'model' ? '准备模型' : operation.value?.flowStep === 'runtime' ? '准备运行库' : operation.value?.stages[operation.value.stageIndex] ?? '正在准备')
const operationPhase = computed(() => setupTransferPhase(operation.value))
const prepareLabel = computed(() => {
  if (busy.value) return '正在准备…'
  if (plan.value?.runtime.installed && selectedModel.value?.installed) return isVideo.value ? '启用原生视频' : '启用原生绘图'
  return operation.value?.status === 'failed' ? '继续准备并启用' : '一键准备并启用'
})
const resourcePaths = computed(() => plan.value ? [
  { label: '运行库', value: plan.value.paths.runtimeRoot }, { label: '底模', value: plan.value.paths.modelsRoot },
  { label: 'LoRA', value: plan.value.paths.lorasRoot }, { label: '下载缓存', value: plan.value.paths.cacheRoot }, { label: '临时文件', value: plan.value.paths.tempRoot },
] : [])
function sourceName(label: string) { return label.startsWith('Python') ? 'Python.org' : label.startsWith('PyTorch') ? 'PyTorch' : label.startsWith('PyPI') ? 'PyPI' : label.startsWith('Microsoft') ? 'Microsoft VC++' : label.startsWith('NVIDIA') ? 'NVIDIA CUDA' : label }
function fillSettings() { if (preparedPaths.value && !locked.value) emit('prepared', { ...preparedPaths.value }) }
let appliedResourceQuery: string | null = null
watch([() => route.query.resource, locked], ([value, isLocked]) => {
  if (typeof value !== 'string') { appliedResourceQuery = null; return }
  if (!isLocked && value !== appliedResourceQuery) { resourceId.value = value; appliedResourceQuery = value }
}, { immediate: true })
let appliedModelQuery: string | null = null
watch([requestedModel, videoRequested, locked], ([requested, video, isLocked]) => {
  const value = video && !plan.value?.models.some(model => model.family === 'video' && model.id === requested)
    ? (isVideo.value ? '' : plan.value?.models.find(model => model.family === 'video')?.id) : requested
  if (!value) { appliedModelQuery = null; return }
  if (!isLocked && plan.value?.models.some(model => model.id === value) && value !== appliedModelQuery) {
    appliedModelQuery = value
    if (modelId.value !== value) void selectModel(value)
  }
})
let revealedResourceLink = ''
watch([() => route.fullPath, () => !!plan.value], async () => {
  const resourceLink = route.path === '/control' && (route.hash === '#control-image-resources'
    || typeof route.query.resource === 'string' && ['', '#control-setup', '#control-inference'].includes(route.hash))
  if (!resourceLink) { revealedResourceLink = ''; return }
  if (!plan.value || revealedResourceLink === route.fullPath) return
  const location = route.fullPath
  await nextTick()
  const details = document.getElementById('control-image-resources')
  if (location !== route.fullPath || !(details instanceof HTMLDetailsElement) || !details.getClientRects().length) return
  revealedResourceLink = location
  details.open = true
  details.scrollIntoView({ block: 'start', behavior: 'instant' })
}, { immediate: true })
const panel = ref<HTMLElement | null>(null), title = ref<HTMLElement | null>(null), actions = ref<HTMLElement | null>(null)
let focusOrigin: HTMLButtonElement | null = null
let focusHost: HTMLElement | null = null
function visible(element: HTMLElement | null) {
  if (!element?.isConnected || element.closest('[hidden], [inert], [aria-hidden="true"]') || getComputedStyle(element).visibility === 'hidden') return false
  const bounds = element.getBoundingClientRect()
  return bounds.width > 0 && bounds.height > 0 && bounds.bottom > 0 && bounds.top < innerHeight
}
async function chooseModel(value: string | number) {
  const active = document.activeElement
  const ownsFocus = active instanceof HTMLElement && (active.id === 'native-model-download' || !!active.closest('[role="listbox"]'))
  await selectModel(String(value))
  await nextTick()
  if (!ownsFocus || locked.value || route.path !== '/control' || !document.hasFocus() || document.activeElement !== document.body || !visible(panel.value)) return
  ;[document.getElementById('native-model-download'), actions.value, title.value].find(visible)?.focus({ preventScroll: true })
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
// Background device checks do not own the backend lock; explicit import inspection does.
watch([busy, inspecting, activating, restarting, workspaceSaving], values => emit('working', values.some(Boolean)), { immediate: true })
onMounted(recheck)
</script>

<style scoped>
.inference-setup { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:var(--s-4); margin-top:var(--s-5); }
.inference-setup > * { grid-column:1 / -1; }
.setup-intro { display:flex; align-items:center; gap:var(--s-3); }
.setup-mark { display:grid; place-items:center; width:48px; height:48px; flex-shrink:0; border:1px solid var(--border-soft); border-radius:var(--r-lg); background:var(--bg-elevated); color:var(--accent); }
.setup-mark .archive-icon { width:24px; height:24px; }
.inference-setup h3, .inference-setup h4, .inference-setup p { margin:0; }
.inference-setup h3 { font-size:var(--fs-title-sm); }
.inference-setup p, .inference-setup li, .inference-setup small { color:var(--text-secondary); line-height:var(--lh-body); overflow-wrap:anywhere; }
.setup-label { color:var(--text-secondary); font-size:var(--fs-label-sm); }
.setup-route { display:flex; flex-wrap:wrap; gap:var(--s-5); padding:0 0 var(--s-2); margin:0; list-style:none; }
.setup-route li { display:flex; align-items:center; gap:var(--s-2); font-size:var(--fs-label-sm); }
.setup-route li > span { display:grid; place-items:center; width:24px; height:24px; border:1px solid var(--border-soft); border-radius:var(--r-pill); color:var(--text-secondary); }
.setup-location { grid-column:1; display:flex; align-items:flex-start; flex-wrap:wrap; align-content:start; gap:var(--s-3); padding:var(--s-4); border:1px solid var(--border-soft); border-radius:var(--r-md); background:var(--bg-base); }
.setup-location .setup-actions { width:100%; }
.setup-model-choice { grid-column:2; align-content:start; padding:var(--s-4); border:1px solid var(--border-soft); border-radius:var(--r-md); background:var(--bg-base); }
.setup-disclosure-hint { display:block; margin-top:var(--s-1); font-size:var(--fs-label-xs); font-weight:400; }
.setup-location > .archive-icon { flex-shrink:0; color:var(--text-secondary); }
.setup-location > div:first-of-type { display:grid; gap:var(--s-1); min-width:0; flex:1; }
code { color:var(--text-primary); font-size:var(--fs-label-sm); overflow-wrap:anywhere; }
.setup-actions, .setup-primary { display:flex; align-items:center; flex-wrap:wrap; gap:var(--s-3); }
.setup-status { display:flex; align-items:flex-start; gap:var(--s-3); padding:var(--s-4); border-radius:var(--r-lg); background:var(--bg-elevated); }
.setup-status > .archive-icon { color:var(--text-secondary); flex-shrink:0; }
.setup-status[data-state="ready"] > .archive-icon, .setup-status[data-state="available"] > .archive-icon { color:var(--success-text); }
.setup-status > div { display:grid; gap:var(--s-1); flex:1; min-width:0; }
.setup-status strong, .setup-model strong { color:var(--text-primary); }
.setup-model { display:flex; align-items:center; gap:var(--s-4); flex-wrap:wrap; padding:var(--s-4) 0; border-block:1px solid var(--border-soft); }
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
.setup-field input { width:100%; min-width:0; }
.inference-setup .setup-error { color:var(--danger-text); }
.inference-setup :is(input,button):disabled { color:var(--text-disabled); }
.inference-setup :is(input,button,summary,a,#native-setup-title,.setup-primary):focus-visible { outline:none; box-shadow:var(--focus-shadow); }
.inference-setup a:not(.btn) { color:var(--accent); text-decoration:underline; text-underline-offset:3px; }
@media(forced-colors:active) { .inference-setup :is(#native-setup-title,.setup-primary):focus-visible { outline:2px solid Highlight; outline-offset:2px; } }
@media(max-width:768px) { .setup-fields, .setup-paths { grid-template-columns:minmax(0,1fr); } .setup-status { flex-wrap:wrap; } .setup-location { align-items:flex-start; flex-wrap:wrap; } .setup-budget { width:100%; } }
@container(max-width:640px) { .inference-setup { grid-template-columns:1fr; } .setup-model-choice, .setup-location { grid-column:1; } .setup-fields { grid-template-columns:1fr; } }
</style>
