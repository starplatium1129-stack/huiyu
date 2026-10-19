<template>
  <section ref="setupRoot" class="local-setup" aria-labelledby="local-setup-title">
    <div class="setup-heading">
      <div><span class="panel-kicker">其他本机环境</span><h2 id="local-setup-title">聊天与兼容配置</h2></div>
      <span class="setup-platform"><ArchiveIcon name="model" />Windows · NVIDIA</span>
    </div>
    <p v-if="!isLocal" class="setup-note">请在运行绘遇的电脑上完成配置。</p>
    <template v-else>
      <ol class="setup-steps" :style="{ '--setup-progress': stepIndex / (steps.length - 1) }" aria-label="首次配置步骤">
        <li v-for="(step, index) in steps" :key="step.id" :data-current="guideStep === step.id" :data-done="index < stepIndex" :aria-current="guideStep === step.id ? 'step' : undefined">
          <button v-if="index === 0 && index < stepIndex && !setupBusy" class="setup-step-number" type="button" aria-label="返回第 1 步：存放位置" @click="guideStep = 'location'"><ArchiveIcon name="success" /></button>
          <span v-else class="setup-step-number"><ArchiveIcon v-if="index < stepIndex" name="success" /><template v-else>{{ index + 1 }}</template></span>
          <strong>{{ step.label }}</strong><ArchiveIcon v-if="index < 2" class="setup-step-arrow" name="chevron-down" />
        </li>
      </ol>
      <p v-if="error" class="setup-error" role="alert">{{ error }}</p>
      <p v-if="workspaceError && !workspaceOpen" class="setup-error" role="alert">{{ workspaceError }}</p>
      <div v-if="workspacePending" class="setup-restart" role="status">
        <ArchiveIcon name="refresh" /><div><h3>新位置已保存</h3><code>{{ workspaceSavedRoot }}</code></div>
        <button v-if="desktop?.restartForSetup" class="btn btn-primary" type="button" :disabled="setupBusy || workspaceSaving || restarting" @click="restartForSetup">{{ restarting ? '正在重启…' : '重启并继续' }}</button>
        <span v-else>退出并重新打开绘遇后继续。</span>
      </div>
      <div v-else-if="guideStep === 'location'" v-content-motion:left="guideStep" class="setup-location-step">
        <div class="setup-step-title"><div><span class="setup-label">第 1 步</span><h3 ref="locationTitle" tabindex="-1">模型存到哪里？</h3></div></div>
        <div class="setup-location-card">
          <span class="setup-folder"><ArchiveIcon name="folder" /></span>
          <div><strong>AI 工作区</strong><code>{{ snapshot?.workspace.path || (loading ? '正在读取位置…' : '位置尚未确认') }}</code><span>模型与运行环境统一存放</span></div>
          <button v-if="desktop" ref="workspaceButton" class="btn btn-ghost" type="button" :disabled="loading || workspaceLoading || workspaceSaving || setupBusy" @click="chooseWorkspace"><ArchiveIcon name="folder" />{{ workspaceLoading ? '选择中…' : '选择文件夹' }}</button>
        </div>
        <div class="setup-location-actions">
          <button class="btn btn-primary" type="button" :disabled="!snapshot || !currentCheck || setupBusy || workspaceLoading || workspaceSaving" @click="guideStep = 'download'">使用此位置，下一步<ArchiveIcon name="chevron-down" class="setup-next-icon" /></button>
          <button v-if="!currentCheck" class="btn btn-ghost" type="button" :disabled="loading" @click="refresh"><ArchiveIcon name="refresh" />{{ loading ? '检查中…' : '重新检查' }}</button>
          <button v-if="loading" class="btn btn-ghost" type="button" @click="cancelCheck">取消检查</button>
        </div>
      </div>
      <template v-if="snapshot">
        <div v-show="guideStep !== 'location' && !workspacePending" v-content-motion:right="guideStep" class="setup-download-step">
          <div class="setup-step-title">
            <div><span class="setup-label">第 {{ guideStep === 'ready' ? '3' : '2' }} 步</span><h3 ref="downloadTitle" tabindex="-1">{{ guideStep === 'ready' ? '准备完成' : setupBusy ? '正在自动配置' : '确认要下载的内容' }}</h3></div>
            <button v-if="guideStep === 'download' && !setupBusy" class="btn btn-quiet btn-sm" type="button" @click="guideStep = 'location'">更换位置</button>
          </div>
          <LocalSetupAutomation :snapshot="snapshot" :status-confirmed="currentCheck" :workspace-blocked="workspacePending || workspaceUnconfirmed" :can-restart="!!desktop?.restartForSetup" :restarting="restarting" @refresh="refresh" @download-result="recordDownload" @model-selected="selectSetupModel" @phase="onPhase" @restart="restartForSetup" @workspace="guideStep = 'location'" />
        </div>
        <details v-if="guideStep !== 'location' && !setupBusy" class="setup-details">
          <StudioDisclosureSummary>已有环境与手动管理</StudioDisclosureSummary>
          <div data-disclosure-content>
            <p class="setup-note">{{ basicComplete ? '环境、模型、连接与节点已确认。' : nextStep }}</p>
            <LocalSetupPreparation :snapshot="snapshot" :desktop="!!desktop" :workspace-pending="workspacePending" :workspace-unconfirmed="workspaceUnconfirmed" @workspace="openWorkspace" @refresh="refresh" @verification-result="recordVerification" @download-result="recordDownload" />
            <dl class="setup-paths"><dt>工作区</dt><dd>{{ snapshot.workspace.path }}</dd><dt>ComfyUI</dt><dd>{{ snapshot.comfy.path }}</dd><dt>服务地址</dt><dd>{{ snapshot.comfy.host }}</dd></dl>
          </div>
        </details>
      </template>
      <CompanionWorkspaceSettings v-if="desktop" :open="workspaceOpen" v-model="workspaceDraft" :saving="workspaceSaving" :error="workspaceError" :return-focus-el="workspaceButton" @close="closeWorkspace" @save="saveWorkspace" />
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import ArchiveIcon from './visual/ArchiveIcon.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import LocalSetupPreparation from './LocalSetupPreparation.vue'
import LocalSetupAutomation from './LocalSetupAutomation.vue'
import CompanionWorkspaceSettings from './CompanionWorkspaceSettings.vue'
import { useLocalSetup } from '../composables/useLocalSetup'

type GuideStep = 'location' | 'download' | 'ready'
const guideStep = ref<GuideStep>('location')
const setupRoot = ref<HTMLElement | null>(null)
const locationTitle = ref<HTMLElement | null>(null), downloadTitle = ref<HTMLElement | null>(null)
const setupBusy = ref(false)
const steps: { id: GuideStep; label: string }[] = [{ id: 'location', label: '存放位置' }, { id: 'download', label: '下载与安装' }, { id: 'ready', label: '开始创作' }]
const stepIndex = computed(() => steps.findIndex(step => step.id === guideStep.value))
watch(guideStep, async step => {
  const origin = document.activeElement
  if (!(origin instanceof HTMLElement) || !setupRoot.value?.contains(origin)) return
  await nextTick()
  // Background setup may change phases while the user is working elsewhere.
  // Only replace focus that belonged to a control removed or hidden by this step.
  const title = step === 'location' ? locationTitle.value : downloadTitle.value
  if (guideStep.value === step && title?.isConnected && (document.activeElement === document.body
    || document.activeElement === origin && !origin.getClientRects().length)) title.focus()
})
const { isLocal, desktop, snapshot, loading, error, nextStep, basicComplete, currentCheck,
  workspaceButton, workspaceOpen, workspaceDraft, workspaceSavedRoot, workspaceLoading, workspaceSaving, workspaceError, workspacePending, workspaceUnconfirmed, restarting,
  refresh, cancelCheck, selectSetupModel, recordDownload, recordVerification,
  openWorkspace, chooseWorkspace, closeWorkspace, saveWorkspace, restartForSetup } = useLocalSetup()
function onPhase(phase: 'selection' | 'preparing' | 'ready') {
  setupBusy.value = phase === 'preparing'
  if (phase === 'preparing') guideStep.value = 'download'
  else if (phase === 'ready') guideStep.value = 'ready'
  else if (guideStep.value === 'ready') guideStep.value = 'download'
}
</script>

<style scoped>
.local-setup { color:var(--text-primary); overflow-wrap:anywhere; }
.setup-heading, .setup-step-title, .setup-location-actions { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:var(--s-3); }
.local-setup h2, .local-setup h3 { margin:0; }
.local-setup h3 { font-size:var(--fs-title-xs); }
.setup-platform { display:flex; align-items:center; gap:var(--s-2); color:var(--text-secondary); font-size:var(--fs-label-sm); }
.setup-steps { position:relative; display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); margin:var(--s-5) 0; padding:0; list-style:none; border-block:1px solid var(--border-soft); }
/* Lucian #042 · MIT (c) 2026 Seokwoooo. Progress follows the real setup phases. */
.setup-steps::after { content:''; position:absolute; inset:auto 0 -1px; height:2px; background:var(--accent); transform:scaleX(var(--setup-progress)); transform-origin:left; transition:transform var(--motion-surface) var(--ease-out); }
.setup-steps li { display:flex; align-items:center; gap:var(--s-3); min-height:72px; padding:var(--s-3); color:var(--text-secondary); }
.setup-step-number { display:grid; place-items:center; flex-shrink:0; width:32px; height:32px; padding:0; border:1px solid var(--border-strong); border-radius:var(--r-pill); background:var(--bg-surface); color:inherit; font:inherit; }
button.setup-step-number { cursor:pointer; }
button.setup-step-number:hover { border-color:var(--border-strong); color:var(--text-primary); background:transparent; }
.setup-steps strong { font-size:var(--fs-label); }
.setup-steps li[data-current="true"] { color:var(--accent); background:var(--accent-soft); }
.setup-steps li[data-current="true"] .setup-step-number { border-color:var(--accent); }
.setup-steps li[data-done="true"] { color:var(--success-text); }
.setup-step-arrow { margin-left:auto; transform:rotate(-90deg); }
.setup-next-icon { transform:rotate(-90deg); }
.setup-label { display:block; color:var(--text-secondary); font-size:var(--fs-label-sm); margin-bottom:var(--s-2); }
.setup-location-step, .setup-download-step { display:grid; gap:var(--s-4); }
.setup-location-card { display:flex; align-items:center; gap:var(--s-4); padding:var(--s-5); background:var(--bg-deep); border:1px solid var(--border-soft); border-radius:var(--r-lg); }
.setup-folder { display:grid; place-items:center; flex-shrink:0; width:56px; height:56px; border-radius:var(--r-lg); background:var(--bg-surface); color:var(--accent); }
.setup-folder .archive-icon { width:28px; height:28px; }
.setup-location-card > div { display:grid; gap:var(--s-2); min-width:0; flex:1; }
.setup-location-card code { font-size:var(--fs-label); }
.setup-location-card span:not(.setup-folder), .setup-note { color:var(--text-secondary); font-size:var(--fs-label-sm); line-height:var(--lh-body); }
.setup-location-actions { justify-content:flex-start; }
.setup-location-actions > .btn-primary { min-height:48px; }
.setup-error { color:var(--danger-text); line-height:var(--lh-body); }
.setup-restart { display:flex; align-items:center; flex-wrap:wrap; gap:var(--s-4); padding:var(--s-4); background:var(--accent-soft); border-radius:var(--r-lg); }
.setup-restart > div { flex:1; min-width:0; }
.setup-restart code { display:block; margin-top:var(--s-2); }
.setup-details { margin-top:var(--s-5); border-top:1px solid var(--border-soft); padding-top:var(--s-2); }
.setup-paths { display:grid; gap:var(--s-2); font-size:var(--fs-label-sm); }
.setup-paths dt { color:var(--text-secondary); }
.setup-paths dd { margin:0 0 var(--s-2); }
.local-setup .btn { flex-shrink:0; }
.local-setup button:disabled { color:var(--text-disabled); opacity:1; cursor:not-allowed; }
.local-setup :is(button,a,summary):focus-visible { outline:none; box-shadow:var(--focus-shadow); }
@media(prefers-reduced-motion:reduce) { :root:not([data-motion='full']) .setup-steps::after { transition:none; } }
:root:is([data-motion='reduce'],[data-motion='reduced']) .setup-steps::after { transition:none; }
@media(max-width:1050px) { .setup-location-card { flex-wrap:wrap; } .setup-location-card > .btn { margin-left:72px; } }
@media(max-width:650px) { .setup-steps li { padding:var(--s-3) var(--s-2); gap:var(--s-2); } .setup-step-arrow { display:none; } .setup-step-number { width:26px; height:26px; } }
</style>
