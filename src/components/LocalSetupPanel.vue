<template>
  <section id="control-setup" class="panel-card local-setup" aria-labelledby="local-setup-title">
    <div class="setup-heading">
      <div><span class="panel-kicker">本机起步</span><h2 id="local-setup-title" class="panel-heading">绘图首次配置</h2></div>
      <div v-if="isLocal" class="setup-actions">
        <button class="btn btn-ghost btn-sm" type="button" :disabled="loading" @click="refresh">
          <ArchiveIcon name="refresh" />{{ loading ? '检查中…' : '重新检查' }}
        </button>
        <button v-if="loading" class="btn btn-ghost btn-sm" type="button" @click="cancelCheck">取消检查</button>
      </div>
    </div>
    <p v-if="!isLocal" class="setup-note">请在运行绘遇的电脑上完成配置。</p>
    <template v-else>
      <div class="setup-result" :data-state="basicComplete ? 'checked' : 'pending'" role="status" aria-live="polite">
        <ArchiveIcon :name="basicComplete ? 'success' : 'info'" /><strong>{{ basicComplete ? '基础配置已就绪' : summary }}</strong>
      </div>
      <p v-if="error" class="setup-error" role="alert">{{ error }}</p>
      <ol v-if="snapshot" class="setup-overview" aria-label="绘图准备进度">
        <li v-for="step in checklist" :key="step.id" :data-ready="step.ready">
          <ArchiveIcon :name="step.ready ? 'success' : 'info'" aria-hidden="true" />
          <span>{{ step.label }}</span><strong>{{ step.ready ? '已确认' : '待确认' }}</strong>
        </li>
      </ol>
      <p v-if="!basicComplete" class="setup-next" role="status"><strong>下一步</strong> {{ nextStep }}</p>
      <div class="setup-actions">
        <button v-if="desktop" ref="workspaceButton" class="btn btn-ghost btn-sm" type="button" :disabled="workspaceLoading || workspaceSaving" @click="openWorkspace">
          <ArchiveIcon name="gear" />{{ workspaceLoading ? '读取目录中…' : '选择 AI 工作区' }}
        </button>
        <RouterLink class="btn btn-ghost btn-sm" to="/prompt-builder"><ArchiveIcon name="spark" />{{ basicComplete ? '进入画室' : '先写草稿' }}</RouterLink>
      </div>
      <p v-if="snapshot" class="setup-location">AI 工作区：<code>{{ snapshot.workspace.path }}</code></p>
      <p v-if="workspaceNotice" class="setup-note" role="status">{{ workspaceNotice }}</p>
      <button v-if="workspacePending && desktop?.restartForSetup" class="btn btn-primary btn-sm" type="button" @click="restartForSetup">重启并继续</button>
      <p v-if="downloadNotice" class="setup-note" role="status">{{ downloadNotice }}</p>
      <p v-if="workspaceError && !workspaceOpen" class="setup-error" role="alert">{{ workspaceError }}</p>
      <LocalSetupAutomation v-if="snapshot" :snapshot="snapshot" :status-confirmed="currentCheck" :workspace-blocked="workspacePending || workspaceUnconfirmed" @refresh="refresh" @download-result="recordDownload" @model-selected="selectSetupModel" />
      <LocalSetupPreparation v-if="snapshot" :snapshot="snapshot" :desktop="!!desktop" :workspace-pending="workspacePending" :workspace-unconfirmed="workspaceUnconfirmed" @workspace="openWorkspace" @refresh="refresh" @verification-result="recordVerification" @download-result="recordDownload" />
      <details class="setup-details">
        <StudioDisclosureSummary>路径与检查结果<span v-if="snapshot">{{ checkedAtLabel }}</span></StudioDisclosureSummary>
        <div data-disclosure-content class="setup-detail-body">
          <div class="setup-detail">
            <h3>1. AI 工作区与 ComfyUI</h3>
            <template v-if="snapshot">
              <p>工作区：{{ fileLabel(snapshot.workspace.state) }}</p><code>{{ snapshot.workspace.path }}</code>
              <p>ComfyUI 目录：{{ fileLabel(snapshot.comfy.installation) }}</p><code>{{ snapshot.comfy.path }}</code>
              <p v-if="snapshot.comfy.layout === 'portable'">Portable 环境，可由绘遇启动。</p>
              <p v-else-if="snapshot.comfy.layout === 'external-venv'">外部管理的环境，请由原入口启动。</p>
              <p v-else-if="snapshot.comfy.layout === 'venv'">已识别 venv 环境。</p>
              <p v-else>未识别的环境，请由原入口启动。</p>
              <p>服务地址：</p><code>{{ snapshot.comfy.host }}</code>
            </template>
            <p v-else>请先重新检查。</p>
            <p v-if="!desktop">浏览器模式：将启动环境中的 AI_WORKSPACE_ROOT 设为 ComfyUI 的父目录，重启服务后生效。</p>
            <div class="setup-links"><a href="https://docs.comfy.org/installation/manual_install" target="_blank" rel="noopener noreferrer">ComfyUI 官方安装说明</a><a href="https://docs.comfy.org/installation/comfyui_portable_windows" target="_blank" rel="noopener noreferrer">Windows 便携版说明</a></div>
          </div>
          <div class="setup-detail">
            <h3>2. 绘图模型</h3>
            <ul v-if="snapshot" class="setup-models">
              <li v-for="model in recommendedModels" :key="model.id"><div><strong>{{ model.label }}</strong><span :data-state="model.state">{{ fileLabel(model.state) }}{{ model.bytes === null ? '' : ' · ' + formatBytes(model.bytes) }}</span></div><code>{{ model.path }}</code></li>
            </ul>
            <a href="https://huggingface.co/circlestone-labs/Anima/tree/f973fc41ec7545364ac9776c2440285f43ff2a30/split_files" target="_blank" rel="noopener noreferrer">Anima 作者固定版本文件目录</a>
            <template v-if="otherModels.length">
              <h4>其他 Anima 底模</h4>
              <ul class="setup-models"><li v-for="model in otherModels" :key="model.id"><div><strong>{{ model.label }}</strong><span :data-state="model.state">{{ fileLabel(model.state) }}</span></div><code>{{ model.path }}</code></li></ul>
            </template>
          </div>
          <div class="setup-detail">
            <h3>3. 工作流节点</h3>
            <template v-if="snapshot">
              <p>{{ nodeLabel }}</p>
              <p v-if="snapshot.nodes.required.length">所需注册名：</p><code v-if="snapshot.nodes.required.length">{{ snapshot.nodes.required.join(' · ') }}</code>
              <p v-if="snapshot.nodes.missing.length" class="setup-warning">缺少注册名：{{ snapshot.nodes.missing.join(' · ') }}</p>
            </template>
            <p v-if="snapshot?.nodes.missing.length">补齐节点后重启 ComfyUI，再重新检查。</p>
            <a href="https://github.com/kijai/ComfyUI-KJNodes" target="_blank" rel="noopener noreferrer">KJNodes 作者仓库</a>
          </div>
          <div class="setup-detail">
            <h3>4. 设备信息</h3>
            <ul v-if="snapshot?.hardware.state === 'reported' && snapshot.hardware.devices.length" class="setup-devices">
              <li v-for="(device, index) in snapshot.hardware.devices" :key="index">{{ device.name }} · {{ device.type }} · 内存总量 {{ device.vramBytes === null ? '未知' : formatBytes(device.vramBytes) }}</li>
            </ul>
            <p v-else>设备信息暂不可用。</p>
            <p>系统内存总量：{{ snapshot?.hardware.state === 'reported' && snapshot.hardware.ramBytes !== null ? formatBytes(snapshot.hardware.ramBytes) : '未知' }}</p>
          </div>
        </div>
      </details>
      <CompanionWorkspaceSettings v-if="desktop" :open="workspaceOpen" v-model="workspaceDraft" :saving="workspaceSaving" :error="workspaceError" :return-focus-el="workspaceButton" @close="closeWorkspace" @save="saveWorkspace" />
    </template>
  </section>
</template>

<script setup lang="ts">
import { RouterLink } from 'vue-router'
import ArchiveIcon from './visual/ArchiveIcon.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import LocalSetupPreparation from './LocalSetupPreparation.vue'
import LocalSetupAutomation from './LocalSetupAutomation.vue'
import CompanionWorkspaceSettings from './CompanionWorkspaceSettings.vue'
import { formatSetupBytes as formatBytes } from '../utils/localSetupPreparation.ts'
import { useLocalSetup } from '../composables/useLocalSetup'

const { isLocal, desktop, snapshot, loading, error, summary, nextStep, basicComplete, currentCheck,
  recommendedModels, otherModels, nodeLabel, checkedAtLabel, checklist, fileLabel,
  workspaceButton, workspaceOpen, workspaceDraft, workspaceLoading, workspaceSaving,
  workspaceNotice, workspaceError, workspacePending, workspaceUnconfirmed, downloadNotice,
  refresh, cancelCheck, selectSetupModel, recordDownload, recordVerification,
  openWorkspace, closeWorkspace, saveWorkspace, restartForSetup } = useLocalSetup()
</script>

<style scoped>
@reference "../assets/css/tailwind.css";
.local-setup { border:1px solid var(--border-soft); background:var(--bg-surface); overflow-wrap:anywhere; }
.setup-heading, .setup-actions { display:flex; align-items:center; flex-wrap:wrap; gap:var(--s-2); }
.setup-heading { justify-content:space-between; gap:var(--s-3); }
.panel-heading { margin:0; font-size:var(--fs-title-sm); }
.setup-note, .setup-next, .setup-detail p { color:var(--text-secondary); font-size:var(--fs-label); line-height:var(--lh-body); margin:var(--s-3) 0; }
.setup-result { display:flex; align-items:center; gap:var(--s-2); font-size:var(--fs-label); margin-top:var(--s-4); }
.setup-result[data-state="checked"] { color:var(--success-text); }
.setup-overview { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:var(--s-2) var(--s-4); margin:var(--s-3) 0; padding:0; list-style:none; color:var(--text-secondary); font-size:var(--fs-label); }
.setup-overview li { display:flex; flex-wrap:wrap; align-items:center; align-content:start; gap:var(--s-2); padding:var(--s-3); border:1px solid var(--border-soft); border-radius:var(--r-md); background:var(--bg-deep); }
.setup-actions .btn, .setup-heading .btn { flex-shrink:0; white-space:nowrap; }
.setup-location { color:var(--text-secondary); font-size:var(--fs-label-xs); line-height:var(--lh-body); }
.setup-location code { color:var(--text-primary); }
.setup-overview strong { font-size:var(--fs-label-xs); font-weight:500; }
.setup-overview li[data-ready="true"] strong { color:var(--success-text); }
@media(max-width:1100px) { .setup-overview { grid-template-columns:repeat(2,minmax(0,1fr)); } }
@media(max-width:600px) { .setup-overview { grid-template-columns:1fr; } }
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
