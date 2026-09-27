<template>
  <section id="control-library" class="resource-library tw:mb-s-5 tw:p-s-5 tw:rounded-xl tw:text-primary tw:min-w-0" aria-labelledby="resource-library-title">
    <header class="resource-heading tw:flex tw:items-center tw:justify-between tw:gap-s-4">
      <div><span class="resource-eyebrow">离线资源</span><h2 id="resource-library-title">让喜欢的画面，随时在这里</h2></div>
      <ArchiveIcon name="image" class="resource-emblem" />
    </header>
    <p class="resource-description">基础图片随应用保留。安装已批准的资源版本后，可离线查看更完整的画面。</p>
    <p v-if="!isLocal" role="status">资源管理仅在本机控制室开放。</p>
    <template v-else>
      <div class="resource-version tw:flex tw:flex-wrap tw:items-center tw:gap-s-2 tw:text-label"><ArchiveIcon name="book" /><span>{{ status?.mounted ? '正在使用已安装资源' : '正在使用随包基础资源' }}</span>
        <StudioTooltip v-if="status?.current" :content="status.current.identity">
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
        <p v-if="selected" class="resource-description">{{ selected.source === 'offline' ? '从已批准的本地资源包导入。' : selected.downloaded ? '下载缓存已就绪；安装时会重新校验。' : '需要手动下载，完成后再安装。' }}</p>
      </div>
      <div v-if="status?.task" class="resource-task" :aria-busy="status.busy">
        <strong role="status" aria-live="polite">{{ taskMessage }}</strong>
        <p v-if="status.task.error">{{ status.task.error.message }}</p>
        <progress v-if="status.busy" :value="status.task.total ? status.task.bytes : undefined" :max="status.task.total || 1" aria-label="当前资源文件处理进度" />
      </div>
      <div class="resource-actions tw:flex tw:flex-wrap tw:gap-s-2 tw:mt-s-4">
        <button type="button" :disabled="loading || submitting" @click="refresh(true)"><ArchiveIcon name="refresh" />重新检查</button>
        <button v-if="selected?.source === 'http'" type="button" :disabled="!canDownload" @click="run('download')"><ArchiveIcon name="download" />下载资源</button>
        <button v-if="selected" type="button" :disabled="!canImport" @click="run('import')"><ArchiveIcon name="image" />安装所选版本</button>
        <button v-if="status?.recoveryRequired" type="button" :disabled="!enabled" @click="run('recover')">继续恢复</button>
        <button v-if="status?.canRollback" type="button" :disabled="!enabled" @click="run('rollback')">回退上一版本</button>
        <button v-if="status?.busy" type="button" :disabled="submitting || status.task?.state === 'cancelling'" @click="cancel">取消操作</button>
      </div>
      <p class="resource-footnote tw:mb-0">取消后保留可恢复的内容。资源更新不会覆盖你的作品。</p>
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
  taskMessage, refresh, run, cancel } = library
onMounted(library.start)
onUnmounted(library.stop)
</script>

<style scoped>
@reference "../assets/css/tailwind.css";
.resource-library { border: 1px solid var(--border-soft); background: var(--bg-surface); }
.resource-heading h2 { margin: var(--s-2) 0; @apply tw:text-title-sm tw:leading-label; }
.resource-eyebrow, .resource-description, .resource-footnote { @apply tw:text-secondary tw:text-label tw:leading-loose; }
.resource-description { margin: var(--s-2) 0 var(--s-4); }
.resource-emblem { @apply tw:w-[32px] tw:h-[32px] tw:shrink-0; }
.resource-version { padding-block: var(--s-3); }
.resource-version code { overflow-wrap: anywhere; @apply tw:max-w-full tw:text-secondary; }
.resource-selection { margin-block: var(--s-3); }
.resource-selection label { @apply tw:text-label; }
/* 原生 <select> 已迁移为 StudioSelect：外观由组件统一提供；布局（宽度/最小高度）落在 wrapper。 */
.resource-selection .studio-select-wrapper { @apply tw:w-full tw:min-w-0 tw:min-h-[44px]; }
.resource-notice, .resource-task { border: 1px solid var(--border-strong); @apply tw:rounded-md tw:p-s-3 tw:leading-body tw:text-label; overflow-wrap: anywhere; }
.resource-task p { @apply tw:mb-0; }
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
.resource-actions button { @apply tw:inline-flex tw:items-center tw:justify-center tw:gap-s-2 tw:min-h-[44px]; padding: var(--s-2) var(--s-3); border: 1px solid var(--border-strong); @apply tw:rounded-md tw:text-primary; background: var(--bg-deep); font: inherit; @apply tw:text-label tw:cursor-pointer; }
.resource-actions button:hover:not(:disabled) { background: var(--bg-elevated); }
.resource-actions button:disabled { @apply tw:text-disabled; opacity: 1; @apply tw:cursor-not-allowed; }
.resource-selection :deep(.studio-select-trigger):disabled { @apply tw:text-disabled; opacity: 1; @apply tw:cursor-not-allowed; }
.resource-actions button:focus-visible { outline: 2px solid var(--text-primary); outline-offset: 3px; }
.resource-selection :deep(.studio-select-trigger):focus-visible { outline: 2px solid var(--text-primary); outline-offset: 3px; }
@media (max-width: 480px) { .resource-actions button { flex: 1 1 140px; } }
</style>
