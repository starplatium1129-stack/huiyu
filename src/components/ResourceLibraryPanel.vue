<template>
  <section id="control-library" class="resource-library" aria-labelledby="resource-library-title">
    <header class="resource-heading">
      <div><span class="resource-eyebrow">离线资源</span><h2 id="resource-library-title">让喜欢的画面，随时在这里</h2></div>
      <ArchiveIcon name="image" class="resource-emblem" />
    </header>
    <p class="resource-description">基础图片随应用保留。安装已批准的资源版本后，可离线查看更完整的画面。</p>
    <p v-if="!isLocal" role="status">资源管理仅在本机控制室开放。</p>
    <template v-else>
      <div class="resource-version"><ArchiveIcon name="book" /><span>{{ status?.mounted ? '正在使用已安装资源' : '正在使用随包基础资源' }}</span>
        <code v-if="status?.current" :title="status.current.identity">{{ status.current.releaseId }} · {{ status.current.identity.slice(0, 12) }}</code>
      </div>
      <p v-if="!status && loading" role="status">正在读取资源库…</p>
      <p v-if="error" class="resource-notice" role="alert">{{ error }}</p>
      <p v-if="status?.issue" class="resource-notice" role="alert">{{ status.issue.message }}</p>
      <p v-if="status && !status.configured" class="resource-description">尚未配置已批准的资源库；基础展示不受影响。</p>
      <p v-else-if="status && !status.managementEnabled" class="resource-description">资源管理尚未启用，请由本机管理员完成配置。</p>
      <div v-if="status?.releases.length" class="resource-selection">
        <label for="resource-release">选择资源版本</label>
        <select id="resource-release" v-model="selectedId" :disabled="busy">
          <option v-for="release in status.releases" :key="release.id" :value="release.id">{{ release.label }} · {{ release.kind === 'delta' ? '增量更新' : '完整资源' }}</option>
        </select>
        <p v-if="selected" class="resource-description">{{ selected.source === 'offline' ? '从已批准的本地资源包导入。' : selected.downloaded ? '下载缓存已就绪；安装时会重新校验。' : '需要手动下载，完成后再安装。' }}</p>
      </div>
      <div v-if="status?.task" class="resource-task" :aria-busy="status.busy">
        <strong role="status" aria-live="polite">{{ taskMessage }}</strong>
        <p v-if="status.task.error">{{ status.task.error.message }}</p>
        <progress v-if="status.busy" :value="status.task.total ? status.task.bytes : undefined" :max="status.task.total || 1" aria-label="当前资源文件处理进度" />
      </div>
      <div class="resource-actions">
        <button type="button" :disabled="loading || submitting" @click="refresh(true)"><ArchiveIcon name="refresh" />重新检查</button>
        <button v-if="selected?.source === 'http'" type="button" :disabled="!canDownload" @click="run('download')"><ArchiveIcon name="download" />下载资源</button>
        <button v-if="selected" type="button" :disabled="!canImport" @click="run('import')"><ArchiveIcon name="image" />安装所选版本</button>
        <button v-if="status?.recoveryRequired" type="button" :disabled="!enabled" @click="run('recover')">继续恢复</button>
        <button v-if="status?.canRollback" type="button" :disabled="!enabled" @click="run('rollback')">回退上一版本</button>
        <button v-if="status?.busy" type="button" :disabled="submitting || status.task?.state === 'cancelling'" @click="cancel">取消操作</button>
      </div>
      <p class="resource-footnote">取消后保留可恢复的内容。资源更新不会覆盖你的作品。</p>
    </template>
  </section>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import ArchiveIcon from './visual/ArchiveIcon.vue'
import { useResourceLibrary } from '../composables/useResourceLibrary'
const library = useResourceLibrary()
const { isLocal, status, error, loading, submitting, selectedId, selected, busy, enabled, canImport, canDownload,
  taskMessage, refresh, run, cancel } = library
onMounted(library.start)
onUnmounted(library.stop)
</script>

<style scoped>
.resource-library { margin-bottom: var(--s-5); padding: var(--s-5); border: 1px solid var(--border-soft); border-radius: var(--r-xl); background: var(--bg-surface); color: var(--text-primary); min-width: 0; }
.resource-heading { display: flex; align-items: center; justify-content: space-between; gap: var(--s-4); }
.resource-heading h2 { margin: var(--s-2) 0; font-size: var(--fs-title-sm); line-height: var(--lh-label); }
.resource-eyebrow, .resource-description, .resource-footnote { color: var(--text-secondary); font-size: var(--fs-label); line-height: var(--lh-loose); }
.resource-description { margin: var(--s-2) 0 var(--s-4); }
.resource-emblem { width: 32px; height: 32px; flex-shrink: 0; }
.resource-version { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s-2); padding-block: var(--s-3); font-size: var(--fs-label); }
.resource-version code { overflow-wrap: anywhere; max-width: 100%; color: var(--text-secondary); }
.resource-selection { display: grid; gap: var(--s-2); margin-block: var(--s-3); }
.resource-selection label { font-size: var(--fs-label); }
.resource-selection select {
  width: 100%;
  min-width: 0;
  min-height: 44px;
  padding: var(--s-3) var(--s-7) var(--s-3) var(--s-3);
  border: 1px solid var(--border-soft);
  border-radius: var(--r-md);
  background-color: var(--bg-deep);
  color: var(--text-primary);
  font: inherit;
  cursor: pointer;
  outline: none;
  -webkit-appearance: none;
  appearance: none;
  background-image:
    linear-gradient(45deg, transparent 50%, var(--text-muted) 50%),
    linear-gradient(135deg, var(--text-muted) 50%, transparent 50%);
  background-repeat: no-repeat;
  background-position:
    calc(100% - 14px) calc(50% - 1px),
    calc(100% - 10px) calc(50% - 1px);
  background-size: 5px 5px;
  transition: border-color var(--motion-hover) var(--ease-out);
}
.resource-selection select:hover:not(:disabled) { border-color: var(--accent); }
.resource-notice, .resource-task { border: 1px solid var(--border-strong); border-radius: var(--r-md); padding: var(--s-3); line-height: var(--lh-body); font-size: var(--fs-label); overflow-wrap: anywhere; }
.resource-task p { margin-bottom: 0; }
.resource-task progress {
  display: block;
  width: 100%;
  height: 8px;
  margin-top: var(--s-3);
  overflow: hidden;
  border: 0;
  border-radius: var(--r-pill);
  background: var(--bg-deep);
  -webkit-appearance: none;
  appearance: none;
}
.resource-task progress::-webkit-progress-bar { background: var(--bg-deep); }
.resource-task progress::-webkit-progress-value { border-radius: var(--r-pill); background: var(--accent); }
.resource-task progress::-moz-progress-bar { border-radius: var(--r-pill); background: var(--accent); }
.resource-actions { display: flex; flex-wrap: wrap; gap: var(--s-2); margin-top: var(--s-4); }
.resource-actions button { display: inline-flex; align-items: center; justify-content: center; gap: var(--s-2); min-height: 44px; padding: var(--s-2) var(--s-3); border: 1px solid var(--border-strong); border-radius: var(--r-md); color: var(--text-primary); background: var(--bg-deep); font: inherit; font-size: var(--fs-label); cursor: pointer; }
.resource-actions button:hover:not(:disabled) { background: var(--bg-elevated); }
.resource-actions button:disabled, .resource-selection select:disabled { color: var(--text-disabled); opacity: 1; cursor: not-allowed; }
.resource-actions button:focus-visible, .resource-selection select:focus-visible { outline: 2px solid var(--text-primary); outline-offset: 3px; }
.resource-footnote { margin-bottom: 0; }
@media (max-width: 480px) { .resource-actions button { flex: 1 1 140px; } }
</style>
