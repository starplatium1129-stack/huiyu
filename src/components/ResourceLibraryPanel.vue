<template>
  <section id="control-library" class="resource-library tw:p-s-5 tw:rounded-xl tw:text-primary tw:min-w-0" aria-labelledby="resource-library-title">
    <header class="resource-heading tw:flex tw:items-center tw:justify-between tw:gap-s-3">
      <div><span class="resource-eyebrow">资源管理</span><h2 id="resource-library-title">离线资源库</h2></div>
      <button v-if="isLocal" class="btn btn-ghost btn-sm" type="button" :disabled="loading || submitting" @click="refresh(true)"><ArchiveIcon name="refresh" />{{ loading ? '检查中…' : '重新检查' }}</button>
    </header>
    <p v-if="!isLocal" role="status">资源管理仅在本机控制室开放。</p>
    <template v-else>
      <div class="resource-version"><span class="resource-label">当前使用</span><strong>{{ !status ? '状态待确认' : status.mounted ? '已安装资源' : '随包基础资源' }}</strong>
        <StudioTooltip v-if="status?.mounted && status.current" :content="status.current.identity">
          <code>{{ status.current.releaseId }} · {{ status.current.identity.slice(0, 12) }}</code>
        </StudioTooltip>
      </div>
      <p v-if="!status && loading" role="status">正在读取资源库…</p>
      <p v-if="error" class="resource-notice" role="alert">{{ error }}</p>
      <p v-if="status?.issue" class="resource-notice" role="alert">{{ status.issue.message }}</p>
      <p v-if="status && !status.configured" class="resource-description">尚未配置已批准的资源库；基础展示不受影响。</p>
      <p v-else-if="status && !status.managementEnabled" class="resource-description">资源管理尚未启用，请由本机管理员完成配置。</p>
      <div v-if="status?.releases.length" class="resource-selection tw:grid tw:gap-s-2">
        <label for="resource-release">选择资源版本</label>
        <StudioSelect id="resource-release" v-model="selectedId" :disabled="busy"
          :options="status?.releases.map(release => ({ value: release.id, label: `${release.label} · ${release.kind === 'delta' ? '增量更新' : '完整资源'}` }))" />
        <p v-if="selected" class="resource-description">{{ selected.source === 'offline' ? '本地资源包 · 安装时校验' : selected.downloaded ? '下载缓存已就绪 · 安装时重新校验' : '在线资源 · 先下载，再安装' }}</p>
      </div>
      <div v-if="status?.task" class="resource-task" :data-state="status.task.state" :aria-busy="status.busy">
        <span class="resource-label">本次任务</span>
        <strong role="status" aria-live="polite">{{ taskMessage }}</strong>
        <p v-if="taskDetail" class="resource-description">{{ taskDetail }}</p>
        <p v-if="status.task.error" class="resource-task-error" role="alert">{{ status.task.error.message }}</p>
        <progress v-if="status.busy" :value="status.task.total ? status.task.bytes : undefined" :max="status.task.total || 1" aria-label="当前资源文件处理进度" />
      </div>
      <div class="resource-actions">
        <div class="resource-primary-actions">
          <button v-if="selected?.source === 'http'" class="btn" :class="selected.downloaded || status?.recoveryRequired ? 'btn-ghost' : 'btn-primary'" type="button" :disabled="!canDownload" @click="run('download')"><ArchiveIcon name="download" />下载资源</button>
          <button v-if="selected" class="btn" :class="canImport && !status?.recoveryRequired ? 'btn-primary' : 'btn-ghost'" type="button" :disabled="!canImport" @click="run('import')"><ArchiveIcon name="image" />安装所选版本</button>
          <button v-if="status?.recoveryRequired" class="btn btn-primary" type="button" :disabled="!enabled" @click="run('recover')">继续恢复</button>
          <button v-if="status?.busy" class="btn btn-ghost" type="button" :disabled="submitting || status.task?.state === 'cancelling'" @click="cancel">{{ status.task?.state === 'cancelling' ? '正在取消…' : '取消操作' }}</button>
        </div>
        <button v-if="status?.canRollback" class="btn btn-ghost btn-sm" type="button" :disabled="!enabled" @click="run('rollback')">回退上一版本</button>
      </div>
      <p class="resource-footnote tw:mb-0">取消后保留可恢复内容；资源更新不覆盖你的作品。</p>
    </template>
  </section>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import ArchiveIcon from './visual/ArchiveIcon.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import { useResourceLibrary } from '../composables/useResourceLibrary'
const library = useResourceLibrary()
const { isLocal, status, error, loading, submitting, selectedId, selected, busy, enabled, canImport, canDownload,
  taskMessage, taskDetail, refresh, run, cancel } = library
onMounted(library.start)
onUnmounted(library.stop)
</script>

<style scoped>
@reference "../assets/css/tailwind.css";
.resource-library { border: 1px solid var(--border-soft); background: var(--bg-surface); }
.resource-heading h2 { margin: var(--s-2) 0 0; @apply tw:text-title-sm tw:leading-label; }
.resource-eyebrow, .resource-description, .resource-footnote { @apply tw:text-secondary tw:text-label tw:leading-loose; }
.resource-description { margin: var(--s-2) 0 0; }
.resource-eyebrow, .resource-label { color:var(--text-muted); font-size:var(--fs-label-xs); }
.resource-version { display:grid; gap:var(--s-2); padding:var(--s-3); margin-block:var(--s-4); border-radius:var(--r-md); background:var(--bg-deep); }
.resource-version strong { font-size:var(--fs-label); }
.resource-version code { overflow-wrap: anywhere; @apply tw:max-w-full tw:text-secondary tw:text-label-xs; }
.resource-selection { margin-block: var(--s-4); }
.resource-selection label { @apply tw:text-label; }
.resource-selection .studio-select-wrapper { @apply tw:w-full tw:min-w-0; }
.resource-selection :deep(.studio-select-trigger) { min-height:40px; }
.resource-notice, .resource-task { border: 1px solid var(--border-strong); @apply tw:rounded-md tw:p-s-3 tw:leading-body tw:text-label; overflow-wrap: anywhere; }
.resource-task p { @apply tw:mb-0; }
.resource-task strong { display:block; margin-top:var(--s-2); }
.resource-notice { color:var(--warning-text); }
.resource-task[data-state="completed"] { border-color:var(--success-text); }
.resource-task[data-state="failed"] { border-color:var(--danger-text); }
.resource-task-error { color:var(--danger-text); }
.resource-task progress {
  @apply tw:block tw:w-full tw:h-[8px] tw:mt-s-3 tw:overflow-hidden;
  border: 0;
  @apply tw:rounded-pill;
  background: var(--bg-deep);
  -webkit-appearance: none;
  appearance: none;
}
.resource-task progress::-webkit-progress-bar { background: var(--bg-deep); }
.resource-task progress::-webkit-progress-value { @apply tw:rounded-pill; background: var(--accent); }
.resource-task progress::-moz-progress-bar { @apply tw:rounded-pill; background: var(--accent); }
.resource-actions, .resource-primary-actions { display:flex; align-items:center; flex-wrap:wrap; gap:var(--s-2); }
.resource-actions { justify-content:space-between; margin-top:var(--s-4); }
.resource-actions .btn:not(.btn-sm) { min-height:40px; }
.resource-footnote { margin:var(--s-3) 0 0; font-size:var(--fs-label-xs); }
.resource-actions button:disabled { @apply tw:text-disabled; opacity: 1; @apply tw:cursor-not-allowed; }
.resource-selection :deep(.studio-select-trigger):disabled { @apply tw:text-disabled; opacity: 1; @apply tw:cursor-not-allowed; }
.resource-actions button:focus-visible { outline: 2px solid var(--text-primary); outline-offset: 3px; }
.resource-selection :deep(.studio-select-trigger):focus-visible { outline: 2px solid var(--text-primary); outline-offset: 3px; }
</style>
