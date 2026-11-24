<template>
  <section id="control-library" ref="libraryRegion" class="resource-library tw:p-s-5 tw:rounded-xl tw:text-primary tw:min-w-0" aria-labelledby="resource-library-title" tabindex="-1" :aria-busy="loading">
    <header class="resource-heading tw:flex tw:items-center tw:justify-between tw:gap-s-3">
      <div><span class="resource-eyebrow">资源管理</span><h2 id="resource-library-title">资源与素材</h2></div>
      <button v-if="isLocal" class="btn btn-ghost btn-sm" type="button" :disabled="loading || submitting" :aria-busy="loading" @click="recheck"><ArchiveIcon name="refresh" />{{ loading ? '检查中…' : '重新检查' }}</button>
    </header>
    <p v-if="!isLocal" role="status">资源管理仅在本机控制室开放。</p>
    <template v-else>
      <section class="media-packs-section" aria-label="在线资源包管理">
        <div class="media-packs-toolbar">
          <div>
            <h3>在线图片资源包</h3>
            <p class="media-packs-lead">安装包默认仅保留角色缩略图，可在此按需下载高清立绘或样张库，完成后自动生效无需重启。</p>
          </div>
          <div class="media-packs-toolbar-actions">
            <button v-if="hasMissingMediaPack" class="btn btn-primary btn-sm" type="button" :disabled="mediaPacks.busy.value" @click="mediaPacks.installPreset('full')">
              <ArchiveIcon name="download" />一键补齐缺失
            </button>
            <button class="btn btn-ghost btn-sm" type="button" :disabled="mediaPacks.loading.value" @click="mediaPacks.refresh(true)">
              <ArchiveIcon name="refresh" />{{ mediaPacks.loading.value ? '检查中…' : '检查更新' }}
            </button>
            <button class="btn btn-ghost btn-sm" type="button" @click="mediaPacks.openOnboarding()">
              <ArchiveIcon name="info" />下载引导
            </button>
          </div>
        </div>

        <div v-if="mediaPacks.task.value && (mediaPacks.busy.value || mediaPacks.task.value.state !== 'completed')" class="media-task-banner" :data-state="mediaPacks.task.value.state">
          <div class="media-task-row">
            <div role="status" aria-live="polite" aria-atomic="true">
              <strong>{{ mediaPacks.task.value.message }}</strong>
              <span v-if="mediaPacks.task.value.mirrorLabel"> · {{ mediaPacks.task.value.mirrorLabel }}</span>
            </div>
            <span v-if="mediaProgressPct !== undefined && mediaPacks.busy.value" class="media-task-pct">{{ mediaProgressPct }}%</span>
          </div>
          <progress
            v-if="mediaPacks.busy.value"
            class="media-panel-progress"
            max="100"
            :value="mediaProgressPct"
            aria-label="资源包下载与安装进度"
          />
          <div v-if="mediaPacks.busy.value" class="media-task-meta">
            <span v-if="mediaPacks.task.value.phase === 'extracting' && mediaPacks.task.value.filesTotal > 0">
              正在解压：{{ mediaPacks.task.value.filesDone }} / {{ mediaPacks.task.value.filesTotal }} 个文件
            </span>
            <span v-else-if="mediaPacks.task.value.total > 0">
              {{ formatPackBytes(mediaPacks.task.value.bytes) }} / {{ formatPackBytes(mediaPacks.task.value.total) }}
            </span>
            <span v-if="mediaPacks.task.value.speedBps > 0">{{ formatPackSpeed(mediaPacks.task.value.speedBps) }}</span>
            <button class="btn btn-ghost btn-sm" type="button" :disabled="mediaPacks.task.value.state === 'cancelling'" @click="mediaPacks.cancel()">
              <ArchiveIcon name="stop" />{{ mediaPacks.task.value.state === 'cancelling' ? '正在暂停…' : '暂停下载' }}
            </button>
          </div>
          <p v-if="mediaPacks.task.value.error" class="resource-task-error" role="alert">{{ mediaPacks.task.value.error }}</p>
        </div>
        <p v-else-if="mediaPacks.task.value?.state === 'completed'" class="media-task-ok" role="status">
          <ArchiveIcon name="success" />{{ mediaPacks.task.value.message }}
        </p>
        <p v-if="mediaPacks.error.value" class="resource-notice" role="alert">{{ mediaPacks.error.value }}</p>

        <div class="media-pack-cards">
          <article v-for="pack in mediaPacks.status.value?.packs ?? []" :key="pack.id" class="media-pack-card">
            <div class="media-pack-card-head">
              <div class="media-pack-title">
                <ArchiveIcon :name="pack.id === 'portraits' ? 'character' : 'image'" />
                <strong>{{ pack.label }}</strong>
              </div>
              <span class="media-pack-state" :data-installed="pack.installed ? '1' : '0'">
                {{ packSourceLabel(pack) }}
              </span>
            </div>
            <p class="media-pack-desc">{{ pack.description }}</p>
            <div class="media-pack-stats">
              <span v-if="pack.installed && pack.installedBytes > 0">已占用 {{ formatPackBytes(pack.installedBytes) }}</span>
              <span v-else-if="pack.remote.bytes > 0">包大小约 {{ formatPackBytes(pack.remote.bytes) }}</span>
              <span v-if="pack.partialBytes > 0 && !pack.installed">已缓存 {{ formatPackBytes(pack.partialBytes) }}（可续传）</span>
              <span v-else-if="pack.installedVersion && !['bundled', 'local', 'offline'].includes(pack.installedVersion)">版本 {{ pack.installedVersion }}</span>
            </div>
            <div class="media-pack-actions">
              <button
                v-if="!pack.installed || pack.remote.updateAvailable"
                class="btn btn-sm"
                :class="pack.installed ? 'btn-ghost' : 'btn-primary'"
                type="button"
                :disabled="mediaPacks.busy.value"
                @click="mediaPacks.startInstall([pack.id])"
              >
                <ArchiveIcon name="download" />
                {{ pack.remote.updateAvailable ? '更新到新版' : pack.partialBytes > 0 ? '继续下载' : '在线下载' }}
              </button>
              <button
                v-else-if="pack.source === 'downloaded'"
                class="btn btn-ghost btn-sm"
                type="button"
                :disabled="mediaPacks.busy.value"
                @click="mediaPacks.startInstall([pack.id])"
              >
                <ArchiveIcon name="refresh" />重新下载校验
              </button>
              <button
                v-if="pack.canUninstall"
                class="btn btn-ghost btn-sm"
                type="button"
                :disabled="mediaPacks.busy.value"
                @click="mediaPacks.uninstall(pack.id)"
              >
                <ArchiveIcon name="trash" />卸载释放空间
              </button>
            </div>
          </article>
        </div>

        <details class="media-mirror-details">
          <summary><ArchiveIcon name="gear" />下载源与镜像加速设置</summary>
          <div class="media-mirror-form">
            <label for="media-mirror-input">自定义 GitHub 镜像加速前缀（留空自动优选内置镜像与直连）</label>
            <div class="media-mirror-row">
              <input
                id="media-mirror-input"
                v-model="mirrorDraft"
                type="url"
                class="studio-input"
                placeholder="例如：https://gh-proxy.org"
              />
              <button class="btn btn-ghost btn-sm" type="button" :disabled="mediaPacks.busy.value" @click="applyMirrorSettings">保存并检查</button>
            </div>
            <p v-if="mediaPacks.status.value?.remoteError" class="media-mirror-note">
              最近索引检查：{{ mediaPacks.status.value.remoteError }}
            </p>
          </div>
        </details>
      </section>

      <ResourceInstallEntry v-if="desktop" />
      <div class="resource-version"><span class="resource-label">当前使用</span><strong>{{ !status ? '状态待确认' : status.mounted ? status.directoryRoot ? '直接使用素材目录' : '已安装资源' : '随包基础资源' }}</strong>
        <StudioTooltip v-if="status?.mounted && status.current" :content="status.current.identity">
          <code tabindex="0">{{ status.current.releaseId }} · {{ status.current.identity.slice(0, 12) }}</code>
        </StudioTooltip>
        <code v-if="status?.directoryRoot">{{ status.directoryRoot }}</code>
      </div>
      <p v-if="!status && loading && !error" role="status">正在读取资源库…</p>
      <p v-if="error" class="resource-notice" role="alert">{{ error }}</p>
      <p v-if="status?.issue" class="resource-notice" role="alert">{{ status.issue.message }}</p>
      <p v-if="!desktop && status && !status.configured" class="resource-description">在绘遇桌面端打开资源安装助手，即可导入官方素材 ZIP。</p>
      <p v-else-if="!desktop && status && !status.managementEnabled" class="resource-description">已配置资源库的管理操作需在本机启用。</p>
      <div v-if="!desktop && status?.releases.length && !status.directoryRoot" class="resource-selection tw:grid tw:gap-s-2">
        <label for="resource-release">选择资源版本</label>
        <StudioSelect id="resource-release" v-model="selectedId" :disabled="busy"
          :options="status?.releases.map(release => ({ value: release.id, label: `${release.label} · ${release.kind === 'delta' ? '增量更新' : '完整资源'}` }))" />
        <p v-if="selected" class="resource-description">{{ selected.source === 'offline' ? '本地资源包 · 安装时校验' : selected.downloaded ? '下载缓存已就绪 · 安装时重新校验' : '在线资源 · 先下载，再安装' }}</p>
      </div>
      <div v-if="status?.task" class="resource-task" :data-state="status.task.state" :aria-busy="status.busy">
        <span class="resource-label">本次任务</span>
        <SetupTransferProgress v-if="status.busy" :title="taskMessage" :phase="status.task.phase"
          :received="status.task.bytes" :total="status.task.total" :message="taskDetail" scope="file" />
        <template v-else>
          <strong role="status" aria-live="polite">{{ taskMessage }}</strong>
          <p v-if="taskDetail" class="resource-description">{{ taskDetail }}</p>
        </template>
        <p v-if="status.task.error" class="resource-task-error" role="alert">{{ status.task.error.message }}</p>
      </div>
      <div v-if="!desktop && !status?.directoryRoot" class="resource-actions">
        <div class="resource-primary-actions">
          <button v-if="selected?.source === 'http'" class="btn" :class="selected.downloaded || status?.recoveryRequired ? 'btn-ghost' : 'btn-primary'" type="button" :disabled="!canDownload" @click="run('download')"><ArchiveIcon name="download" />下载资源</button>
          <button v-if="selected" class="btn" :class="canImport && !status?.recoveryRequired ? 'btn-primary' : 'btn-ghost'" type="button" :disabled="!canImport" @click="run('import')"><ArchiveIcon name="image" />安装所选版本</button>
          <button v-if="status?.recoveryRequired" class="btn btn-primary" type="button" :disabled="!enabled" @click="run('recover')">继续恢复</button>
          <button v-if="status?.busy" class="btn btn-ghost" type="button" :disabled="submitting || status.task?.state === 'cancelling'" @click="cancel">{{ status.task?.state === 'cancelling' ? '正在取消…' : '取消操作' }}</button>
        </div>
        <button v-if="status?.canRollback" class="btn btn-ghost btn-sm" type="button" :disabled="!enabled" @click="run('rollback')">回退上一版本</button>
      </div>
      <p class="resource-footnote tw:mb-0">取消可恢复 · 更新不覆盖作品</p>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import ArchiveIcon from './visual/ArchiveIcon.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import SetupTransferProgress from '@/components/control/SetupTransferProgress.vue'
import ResourceInstallEntry from '@/components/control/ResourceInstallEntry.vue'
import { hasResourceAssistant } from '@/platform/desktop/resourceAssistant'
import { useResourceLibrary } from '../composables/useResourceLibrary'
import { formatPackBytes, formatPackSpeed, useMediaPacks } from '@/composables/useMediaPacks'
import type { MediaPackItem } from '@/api/mediaPacksApi'
const props = defineProps<{ active: boolean }>()
const library = useResourceLibrary(() => props.active)
const mediaPacks = useMediaPacks()
const desktop = hasResourceAssistant()
const { isLocal, status, error, loading, submitting, selectedId, selected, busy, enabled, canImport, canDownload,
  taskMessage, taskDetail, refresh, run, cancel } = library
const libraryRegion = ref<HTMLElement | null>(null)
const mirrorDraft = ref('')
watch(() => mediaPacks.status.value?.settings.mirrorOrigin, value => {
  if (typeof value === 'string') mirrorDraft.value = value
}, { immediate: true })
const hasMissingMediaPack = computed(() =>
  (mediaPacks.status.value?.packs ?? []).some(pack => !pack.installed),
)
const mediaProgressPct = computed<number | undefined>(() => {
  const t = mediaPacks.task.value
  if (!t) return undefined
  if (t.phase === 'extracting' && t.filesTotal > 0) return Math.min(100, Math.round((t.filesDone / t.filesTotal) * 100))
  if (t.phase === 'downloading' && t.total > 0) return Math.min(100, Math.round((t.bytes / t.total) * 100))
  return undefined
})
function packSourceLabel(pack: MediaPackItem): string {
  if (!pack.installed) return '未下载'
  if (pack.remote.updateAvailable) return '有新版可用'
  if (pack.source === 'bundled') return '随程序内置'
  if (pack.source === 'downloaded') return '已下载启用'
  if (pack.source === 'offline') return '已接入离线包'
  if (pack.source === 'local') return '本地样张目录'
  return '已就绪'
}
async function applyMirrorSettings() {
  await mediaPacks.saveSettings({ mirrorOrigin: mirrorDraft.value })
}
function recheck() {
  if (loading.value || submitting.value) return
  libraryRegion.value?.focus({ preventScroll:true })
  void refresh(true)
  void mediaPacks.refresh(true)
}
onMounted(() => {
  library.start()
  mediaPacks.retain()
})
watch(() => props.active, library.syncVisibility)
onUnmounted(() => {
  library.stop()
  mediaPacks.release()
})
</script>

<style scoped>
@reference "../assets/css/tailwind.css";
.resource-library { border: 1px solid var(--border-soft); background: var(--bg-surface); }
.resource-library:focus-visible { outline:2px solid var(--text-secondary); outline-offset:var(--s-1); box-shadow:none; }
.resource-heading h2 { margin:0; }
.resource-description, .resource-footnote { @apply tw:text-secondary tw:text-label tw:leading-loose; }
.resource-description { margin: var(--s-2) 0 0; }
.resource-label { color:var(--text-muted); font-size:var(--fs-label-xs); }
.resource-version { display:grid; gap:var(--s-2); padding:var(--s-3); margin-block:var(--s-4); border-radius:var(--r-md); background:var(--bg-deep); }
.resource-version strong { font-size:var(--fs-label); }
.resource-version code { overflow-wrap: anywhere; @apply tw:max-w-full tw:text-secondary tw:text-label-xs; }
.resource-selection { margin-block: var(--s-4); }
.resource-selection label { @apply tw:text-label; }
.resource-selection .studio-select-wrapper { @apply tw:w-full tw:min-w-0; }
.resource-notice, .resource-task { border: 1px solid var(--border-strong); @apply tw:rounded-md tw:p-s-3 tw:leading-body tw:text-label; overflow-wrap: anywhere; }
.resource-task p { @apply tw:mb-0; }
.resource-task > strong { display:block; margin-top:var(--s-2); }
.resource-task > .transfer-progress { margin-top:var(--s-2); }
.resource-notice { color:var(--warning-text); }
.resource-task[data-state="completed"] { border-color:var(--success-text); }
.resource-task[data-state="failed"] { border-color:var(--danger-text); }
.resource-task-error { color:var(--danger-text); }
.resource-actions, .resource-primary-actions { display:flex; align-items:center; flex-wrap:wrap; gap:var(--s-2); }
.resource-actions { justify-content:space-between; margin-top:var(--s-4); }
.resource-actions .btn:not(.btn-sm) { min-height:40px; }
.resource-footnote { margin:var(--s-3) 0 0; font-size:var(--fs-label-xs); }
.resource-actions button:disabled { @apply tw:text-disabled; opacity: 1; @apply tw:cursor-not-allowed; }
.resource-actions button:focus-visible { outline: none; box-shadow: var(--focus-shadow); }
.media-packs-section { display:grid; gap:var(--s-4); margin-top:var(--s-4); }
.media-packs-toolbar { display:flex; flex-wrap:wrap; align-items:flex-start; justify-content:space-between; gap:var(--s-3); }
.media-packs-toolbar h3 { margin:0; font-size:var(--fs-body-lg); }
.media-packs-lead { margin:var(--s-1) 0 0; color:var(--text-secondary); font-size:var(--fs-label-sm); line-height:1.6; max-inline-size:48em; }
.media-packs-toolbar-actions { display:flex; flex-wrap:wrap; gap:var(--s-2); }
.media-pack-cards { display:grid; grid-template-columns:repeat(auto-fit, minmax(260px, 1fr)); gap:var(--s-4); }
.media-pack-card { display:grid; gap:var(--s-3); align-content:start; padding:var(--s-4); border:1px solid var(--border-soft); border-radius:var(--r-lg); background:var(--bg-deep); min-inline-size:0; }
.media-pack-card-head { display:flex; align-items:center; justify-content:space-between; gap:var(--s-2); }
.media-pack-title { display:inline-flex; align-items:center; gap:var(--s-2); font-size:var(--fs-body); }
.media-pack-state { padding:2px 8px; border-radius:var(--r-pill); font-size:var(--fs-label-xs); border:1px solid var(--border-strong); color:var(--text-secondary); }
.media-pack-state[data-installed="1"] { border-color:var(--success-text); color:var(--success-text); }
.media-pack-desc { margin:0; color:var(--text-secondary); font-size:var(--fs-label-sm); line-height:1.65; }
.media-pack-stats { display:flex; flex-wrap:wrap; gap:var(--s-3); font-size:var(--fs-label-xs); color:var(--text-secondary); font-variant-numeric:tabular-nums; }
.media-pack-actions { display:flex; flex-wrap:wrap; gap:var(--s-2); margin-top:var(--s-1); }
.media-pack-actions button:disabled, .media-packs-toolbar-actions button:disabled { color:var(--text-disabled); opacity:1; }
.media-task-banner { display:grid; gap:var(--s-2); padding:var(--s-3) var(--s-4); border:1px solid var(--border-strong); border-radius:var(--r-md); background:var(--bg-deep); }
.media-task-banner[data-state="failed"] { border-color:var(--danger-text); }
.media-task-row { display:flex; align-items:center; justify-content:space-between; gap:var(--s-3); font-size:var(--fs-label); }
.media-task-row span { color:var(--text-secondary); font-size:var(--fs-label-xs); }
.media-task-pct { font-variant-numeric:tabular-nums; font-weight:600; color:var(--accent); }
.media-panel-progress { inline-size:100%; block-size:8px; appearance:none; border:0 solid; border-radius:var(--r-pill); overflow:clip; background:var(--border-soft); container-type:inline-size; --progress-bar-indeterminate-size:30%; --progress-bar-indeterminate-duration:1.5s; }
.media-panel-progress::-webkit-progress-bar { background:transparent; }
.media-panel-progress::-webkit-progress-value { background:var(--accent); border-radius:var(--r-pill); transition:inline-size 0.25s ease; }
.media-panel-progress::-moz-progress-bar { background:var(--accent); border-radius:var(--r-pill); transition:inline-size 0.25s ease; }
.media-panel-progress:indeterminate::-webkit-progress-value { margin-right:auto; animation:media-panel-indeterminate var(--progress-bar-indeterminate-duration) infinite linear; }
.media-panel-progress:indeterminate::-moz-progress-bar { margin-right:auto; animation:media-panel-indeterminate var(--progress-bar-indeterminate-duration) infinite linear; }
@keyframes media-panel-indeterminate { from, to { inline-size:var(--progress-bar-indeterminate-size); } from { translate:-100%; } to { translate:100cqi; } }
@media (prefers-reduced-motion:reduce) { .media-panel-progress { --progress-bar-indeterminate-duration:10s; } }
.media-task-meta { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:var(--s-2); font-size:var(--fs-label-xs); color:var(--text-secondary); font-variant-numeric:tabular-nums; }
.media-task-ok { display:flex; align-items:center; gap:var(--s-2); margin:0; padding:var(--s-3); border:1px solid var(--success-text); border-radius:var(--r-md); color:var(--success-text); font-size:var(--fs-label-sm); }
.media-mirror-details { border:1px solid var(--border-soft); border-radius:var(--r-md); padding:var(--s-3); background:var(--bg-deep); }
.media-mirror-details summary { display:inline-flex; align-items:center; gap:var(--s-2); cursor:pointer; font-size:var(--fs-label-sm); color:var(--text-secondary); }
.media-mirror-form { display:grid; gap:var(--s-2); margin-top:var(--s-3); }
.media-mirror-form label { font-size:var(--fs-label-xs); color:var(--text-secondary); }
.media-mirror-row { display:flex; flex-wrap:wrap; gap:var(--s-2); }
.media-mirror-row input { flex:1 1 220px; min-inline-size:0; }
.media-mirror-note { margin:0; font-size:var(--fs-label-xs); color:var(--text-secondary); }
</style>
