<template>
  <section ref="setupRoot" class="local-setup" aria-labelledby="local-setup-title">
    <div class="setup-heading">
      <div><h2 id="local-setup-title" ref="setupTitle" tabindex="-1">ComfyUI 绘图与本地聊天</h2></div>
      <button class="btn btn-ghost btn-sm" type="button" :disabled="loading || setupBusy || workspaceSaving" @click="refresh"><ArchiveIcon name="refresh" />{{ loading ? '检查中…' : '重新检查' }}</button>
    </div>
    <p v-if="!isLocal" class="setup-note">请在运行绘遇的电脑上完成配置。</p>
    <template v-else>
      <p v-if="error" class="setup-error" role="alert">{{ error }}</p>
      <p v-if="workspaceError && !workspaceOpen" class="setup-error" role="alert">{{ workspaceError }}</p>
      <div v-if="workspacePending" class="setup-restart" role="status">
        <ArchiveIcon name="refresh" /><div><h3>新位置已保存，重启后继续</h3><code>{{ workspaceSavedRoot }}</code></div>
        <button v-if="desktop?.restartForSetup" class="btn btn-primary" type="button" :disabled="blocked || setupBusy || manualBusy || workspaceSaving || restarting" @click="restartForSetup">{{ restarting ? '正在重启…' : '重启并继续' }}</button>
        <span v-else>退出并重新打开绘遇后继续。</span>
      </div>
      <div class="setup-location-card">
        <span class="setup-folder"><ArchiveIcon name="folder" /></span>
        <div><strong>存放位置</strong><code>{{ snapshot?.workspace.path || (loading ? '正在读取位置…' : '位置尚未确认') }}</code></div>
        <button v-if="desktop" ref="workspaceButton" class="btn btn-ghost btn-sm" type="button" :disabled="blocked || loading || workspaceLoading || workspaceSaving || setupBusy || manualBusy" @click="chooseWorkspace">{{ workspaceLoading ? '选择中…' : '更换位置' }}</button>
      </div>
      <p v-if="!desktop" class="setup-note">需要更换存放位置时，请在绘遇桌面版中选择文件夹。</p>
      <p v-if="!snapshot && loading" role="status" class="setup-note">正在读取推荐模型和下载清单… <button class="btn btn-quiet btn-sm" type="button" @click="cancelCheck">取消检查</button></p>
      <template v-if="snapshot">
        <div v-show="!workspacePending" class="setup-download-step">
          <LocalSetupAutomation :snapshot="snapshot" :status-confirmed="currentCheck" :workspace-blocked="workspacePending || workspaceUnconfirmed" :blocked="blocked || manualBusy || workspaceLoading || workspaceSaving || restarting" :settings-revision="settingsRevision" :can-restart="!!desktop?.restartForSetup" :can-choose-workspace="!!desktop" :restarting="restarting" @refresh="refresh" @download-result="recordDownload" @model-selected="selectSetupModel" @phase="setupPhase = $event" @configured="emit('configured')" @restart="restartForSetup" @workspace="chooseWorkspace" />
        </div>
        <details v-if="!setupBusy" class="setup-details">
          <StudioDisclosureSummary>已有 ComfyUI？手动连接与文件管理</StudioDisclosureSummary>
          <div data-disclosure-content>
            <p class="setup-note">{{ basicComplete ? '已确认环境、模型和服务连接。' : nextStep }}</p>
            <LocalSetupPreparation :snapshot="snapshot" :desktop="!!desktop" :blocked="blocked || workspaceLoading || workspaceSaving || restarting" :workspace-pending="workspacePending" :workspace-unconfirmed="workspaceUnconfirmed" @busy="manualBusy = $event" @workspace="openWorkspace" @refresh="refresh" @verification-result="recordVerification" @download-result="recordDownload" />
            <dl class="setup-paths"><dt>存放位置</dt><dd>{{ snapshot.workspace.path }}</dd><dt>ComfyUI</dt><dd>{{ snapshot.comfy.path }}</dd><dt>服务地址</dt><dd>{{ snapshot.comfy.host }}</dd></dl>
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

const props = defineProps<{ blocked: boolean; settingsRevision: number }>()
const emit = defineEmits<{ busy: [value: boolean]; configured: []; ready: [] }>()
const setupRoot = ref<HTMLElement | null>(null), setupTitle = ref<HTMLElement | null>(null)
const setupPhase = ref<'selection' | 'preparing' | 'ready'>('selection')
const manualBusy = ref(false)
const setupBusy = computed(() => setupPhase.value === 'preparing')
watch(setupPhase, async () => {
  const origin = document.activeElement
  if (!(origin instanceof HTMLElement) || !setupRoot.value?.contains(origin)) return
  await nextTick()
  // Only hand off focus when the user's control was removed by a real task phase.
  if (!setupRoot.value?.getClientRects().length || origin.isConnected && origin.getClientRects().length) return
  if (document.activeElement !== document.body && document.activeElement !== origin) return
  const target = setupRoot.value.querySelector<HTMLElement>('.setup-finished .btn') ?? setupTitle.value
  target?.focus({ preventScroll: true })
})
const { isLocal, desktop, snapshot, loading, error, nextStep, basicComplete, currentCheck,
  workspaceButton, workspaceOpen, workspaceDraft, workspaceSavedRoot, workspaceLoading, workspaceSaving, workspaceError, workspacePending, workspaceUnconfirmed, restarting,
  refresh, cancelCheck, selectSetupModel, recordDownload, recordVerification,
  openWorkspace, chooseWorkspace, closeWorkspace, saveWorkspace, restartForSetup } = useLocalSetup(computed(() => props.blocked || setupBusy.value || manualBusy.value))
watch([setupBusy, manualBusy, workspaceLoading, workspaceSaving, restarting], values => emit('busy', values.some(Boolean)), { immediate: true })
watch(loading, (value, previous) => { if (previous && !value) emit('ready') })
watch(() => props.settingsRevision, () => { void refresh() })
</script>

<style scoped>
.local-setup { display:grid; gap:var(--s-4); color:var(--text-primary); overflow-wrap:anywhere; container-type:inline-size; }
.setup-heading { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:var(--s-3); }
.local-setup h2, .local-setup h3, .local-setup p { margin:0; }
.local-setup h3 { font-size:var(--fs-title-xs); }
.setup-download-step { min-width:0; }
.setup-location-card { display:flex; align-items:center; gap:var(--s-3); padding:var(--s-4); background:var(--bg-base); border:1px solid var(--border-soft); border-radius:var(--r-md); }
.setup-folder { display:grid; place-items:center; flex-shrink:0; width:40px; height:40px; border-radius:var(--r-md); background:var(--bg-surface); color:var(--accent); }
.setup-folder .archive-icon { width:22px; height:22px; }
.setup-location-card > div { display:grid; gap:var(--s-1); min-width:0; flex:1; }
.setup-location-card code { font-size:var(--fs-label); }
.setup-location-card span:not(.setup-folder), .setup-note { color:var(--text-secondary); font-size:var(--fs-label-sm); line-height:var(--lh-body); }
.setup-error { color:var(--danger-text); line-height:var(--lh-body); }
.setup-restart { display:flex; align-items:center; flex-wrap:wrap; gap:var(--s-4); padding:var(--s-4); background:var(--accent-soft); border-radius:var(--r-lg); }
.setup-restart > div { flex:1; min-width:0; }
.setup-restart code { display:block; margin-top:var(--s-2); }
.setup-details { border-top:1px solid var(--border-soft); padding-top:var(--s-2); }
.setup-paths { display:grid; gap:var(--s-2); font-size:var(--fs-label-sm); }
.setup-paths dt { color:var(--text-secondary); }
.setup-paths dd { margin:0 0 var(--s-2); }
.local-setup .btn { flex-shrink:0; }
.local-setup button:disabled { color:var(--text-disabled); opacity:1; cursor:not-allowed; }
.local-setup :is(button,a,summary,#local-setup-title):focus-visible { outline:none; box-shadow:var(--focus-shadow); }
@container(max-width:640px) { .setup-location-card { flex-wrap:wrap; } .setup-location-card > .btn { margin-left:52px; } }
@media(forced-colors:active) { #local-setup-title:focus-visible { outline:2px solid Highlight; } }
</style>
