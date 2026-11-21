<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from 'reka-ui'
import StudioDropdownMenu from '@/components/ui/StudioDropdownMenu.vue'
import StudioDialog from '@/components/ui/StudioDialog.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { useBackup, type BackupSummary } from '@/composables/useBackup'
import { useWorkspaceMigration } from '@/composables/useWorkspaceMigration'
import { useToast } from '@/composables/useToast'

const route = useRoute(), router = useRouter()
const { show } = useToast()
const backup = useBackup(message => show(message))
const migration = useWorkspaceMigration(message => show(message))
const backupFileEl = ref<HTMLInputElement | null>(null)
const pendingSummary = ref<BackupSummary | null>(null)
let backupFileVersion = 0

const localPanelOpen = ref(false)
const panelOpen = computed({
  get: () => localPanelOpen.value || (route.path === '/gallery' && route.query.panel === 'backup'),
  set: value => {
    localPanelOpen.value = value
    if (route.path === '/gallery' && Boolean(route.query.panel === 'backup') !== value) {
      void router.replace({ query: { ...route.query, panel: value ? 'backup' : undefined }, hash: route.hash })
    }
  },
})

const BACKUP_REMIND_DAYS = 7
const backupStale = computed(() => {
  const last = backup.lastBackupAt.value
  if (!last) return true
  return Date.now() - last > BACKUP_REMIND_DAYS * 24 * 60 * 60 * 1000
})
const backupDays = computed(() => {
  const last = backup.lastBackupAt.value
  if (!last) return 0
  return Math.max(0, Math.floor((Date.now() - last) / (24 * 60 * 60 * 1000)))
})
const backupReminder = computed(() => backup.lastBackupAt.value
  ? `距上次备份 ${backupDays.value} 天，建议导出备份`
  : '尚未备份，建议导出备份')

const activeProgressText = computed(() => {
  if (backup.portable.progress.value) return backup.portable.progress.value
  if (backup.exportProgress.value) {
    return backup.workspaceProgress.value || `正在备份图片：${backup.exportProgress.value.completed} / ${backup.exportProgress.value.total}`
  }
  if (backup.imageExportProgress.value) {
    return `正在导出原图：${backup.imageExportProgress.value.completed} / ${backup.imageExportProgress.value.total}`
  }
  if (migration.progress.value) return migration.progress.value
  return ''
})

const restoreDialogOpen = computed({
  get: () => Boolean(backup.pending.value || backup.pendingWorkspace.value),
  set: value => { if (!value) discard() },
})

function pickBackupFile() {
  backupFileEl.value?.click()
}

async function onBackupFilePicked(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  const version = ++backupFileVersion
  input.value = ''
  const summary = await backup.loadFile(file)
  if (version !== backupFileVersion) return
  pendingSummary.value = summary
  panelOpen.value = false
}

function discard() {
  if (backup.busy.value) return
  backupFileVersion++
  backup.discard()
  pendingSummary.value = null
}
</script>

<template>
  <div class="gallery-backup-tools">
    <button
      v-if="activeProgressText"
      class="btn btn-ghost btn-sm gallery-backup-progress"
      type="button"
      role="status"
      @click="panelOpen = true"
    >
      <ArchiveIcon name="refresh" class="spin" />
      <span>{{ activeProgressText }}</span>
    </button>

    <StudioDropdownMenu label="数据与备份" :side-offset="8" align="end">
      <template #trigger>
        <button
          class="btn btn-ghost btn-icon gallery-backup-trigger"
          type="button"
          :aria-label="backupStale ? `数据与备份（${backupReminder}）` : '数据与备份'"
        >
          <ArchiveIcon name="download" />
          <span v-if="backupStale" class="gallery-backup-dot" aria-hidden="true" />
        </button>
      </template>
      <template #default="{ run }">
        <DropdownMenuLabel class="studio-dropdown-label">
          数据与备份<template v-if="backupStale"> · {{ backupReminder }}</template>
        </DropdownMenuLabel>
        <template v-if="backup.desktopActive.value && backup.portable.available">
          <DropdownMenuItem class="studio-dropdown-item" :disabled="backup.busy.value" @select="run(() => backup.portable.run('export'))">
            <ArchiveIcon name="download" /><span>保存完整备份包…</span>
          </DropdownMenuItem>
          <DropdownMenuItem class="studio-dropdown-item" :disabled="backup.busy.value" @select="run(() => backup.portable.run('import'))">
            <ArchiveIcon name="upload" /><span>从完整备份包恢复…</span>
          </DropdownMenuItem>
          <DropdownMenuItem v-if="backup.portable.candidate.value" class="studio-dropdown-item" :disabled="backup.busy.value" @select="run(() => backup.portable.activate())">
            <ArchiveIcon name="spark" /><span>切换到恢复的工作区</span>
          </DropdownMenuItem>
        </template>
        <DropdownMenuItem class="studio-dropdown-item" :disabled="backup.busy.value" @select="run(() => backup.exportBackup())">
          <ArchiveIcon name="download" /><span>{{ backup.desktopActive.value ? '创建工作区备份' : '导出备份 JSON' }}</span>
        </DropdownMenuItem>
        <DropdownMenuItem class="studio-dropdown-item" :disabled="backup.busy.value" @select="run(() => backup.exportImages())">
          <ArchiveIcon name="image" /><span>导出作品图片</span>
        </DropdownMenuItem>
        <DropdownMenuItem class="studio-dropdown-item" :disabled="backup.busy.value" @select="run(pickBackupFile)">
          <ArchiveIcon name="upload" /><span>从备份恢复…</span>
        </DropdownMenuItem>

        <DropdownMenuSeparator class="studio-dropdown-separator" />
        <DropdownMenuLabel class="studio-dropdown-label">存储维护</DropdownMenuLabel>
        <DropdownMenuItem v-if="migration.recoveryPending.value" class="studio-dropdown-item" :disabled="migration.busy.value" @select="run(() => migration.reconcile())">
          <ArchiveIcon name="refresh" /><span>只读核对激活结果</span>
        </DropdownMenuItem>
        <DropdownMenuItem v-if="migration.available.value" class="studio-dropdown-item" :disabled="backup.busy.value || migration.busy.value" @select="run(() => migration.migrate())">
          <ArchiveIcon name="upload" /><span>迁移至本机工作区</span>
        </DropdownMenuItem>
        <DropdownMenuItem v-if="migration.available.value" class="studio-dropdown-item" :disabled="backup.busy.value || migration.busy.value" @select="run(() => migration.migrate(true))">
          <ArchiveIcon name="refresh" /><span>继续已备份的迁移</span>
        </DropdownMenuItem>
        <DropdownMenuItem v-if="migration.bundledAvailable.value" class="studio-dropdown-item" :disabled="backup.busy.value || migration.busy.value || !migration.bundledVerified.value" @select="run(() => migration.enableBundled())">
          <ArchiveIcon name="spark" /><span>启用独立启动界面</span>
        </DropdownMenuItem>
        <DropdownMenuItem class="studio-dropdown-item" :disabled="backup.busy.value" @select="run(() => backup.healthCheck())">
          <ArchiveIcon name="health" /><span>存储体检</span>
        </DropdownMenuItem>
        <DropdownMenuItem class="studio-dropdown-item" :disabled="backup.busy.value" @select="run(() => backup.cleanOrphanImages())">
          <ArchiveIcon name="broom" /><span>清理未引用图片</span>
        </DropdownMenuItem>
        <DropdownMenuItem class="studio-dropdown-item" @select="run(() => router.push('/scene-manager'))">
          <ArchiveIcon name="manager" /><span>内容维护（角色与场景导出）</span>
        </DropdownMenuItem>

        <DropdownMenuSeparator class="studio-dropdown-separator" />
        <DropdownMenuItem class="studio-dropdown-item" @select="run(() => { panelOpen = true })">
          <ArchiveIcon name="info" /><span>数据与备份详情…</span>
        </DropdownMenuItem>
      </template>
    </StudioDropdownMenu>

    <!-- 文件选择器留在临时菜单之外，避免原生选择期间浮层关闭导致回调丢失。 -->
    <input ref="backupFileEl" class="gallery-backup-file-input" hidden type="file" accept="application/json" @change="onBackupFilePicked" />

    <StudioDialog
      v-model:open="panelOpen"
      title="数据与备份"
      :subtitle="backup.desktopActive.value ? '完整备份包含工作区记录与原始媒体，可迁移至其他设备恢复。' : '备份 JSON 包含作品记录、图片与配置，可通过「从备份恢复」导入。'"
      size="md"
      close-label="关闭数据与备份"
    >
      <div class="gallery-backup-dialog-body">
        <div v-if="backupStale" class="gallery-backup-note is-warn" role="status">
          <ArchiveIcon name="health" /><span>{{ backupReminder }}</span>
        </div>
        <div v-if="backup.desktopActive.value && backup.portable.available" class="gallery-backup-group">
          <button type="button" class="btn btn-ghost" :disabled="backup.busy.value" @click="backup.portable.run('export')"><ArchiveIcon name="download" />保存完整备份包…</button>
          <button type="button" class="btn btn-ghost" :disabled="backup.busy.value" @click="backup.portable.run('import')"><ArchiveIcon name="upload" />从完整备份包恢复…</button>
          <p v-if="backup.portable.progress.value" class="gallery-backup-note" role="status">{{ backup.portable.progress.value }}</p>
          <button v-if="backup.portable.progress.value" type="button" class="btn btn-ghost" @click="backup.portable.cancel">取消完整备份操作</button>
          <button v-if="backup.portable.candidate.value" type="button" class="btn btn-primary" :disabled="backup.busy.value" @click="backup.portable.activate">切换到恢复的工作区</button>
        </div>
        <div class="gallery-backup-group">
          <button class="btn btn-primary" type="button" :disabled="backup.busy.value" @click="backup.exportBackup()">
            <ArchiveIcon name="download" />{{ backup.desktopActive.value ? '创建工作区备份' : '导出备份 JSON' }}
          </button>
          <div v-if="backup.exportProgress.value" class="gallery-backup-note" role="status" aria-live="polite">
            {{ backup.workspaceProgress.value || `正在备份图片：${backup.exportProgress.value.completed} / ${backup.exportProgress.value.total}` }}
          </div>
          <button v-if="backup.exportProgress.value" class="btn btn-ghost" type="button" @click="backup.cancelExport()">取消当前备份操作</button>
          <button class="btn btn-ghost" type="button" :disabled="backup.busy.value" @click="backup.exportImages()">
            <ArchiveIcon name="image" />导出作品图片
          </button>
          <div v-if="backup.imageExportProgress.value" class="gallery-backup-note" role="status" aria-live="polite">
            正在导出原图：{{ backup.imageExportProgress.value.completed }} / {{ backup.imageExportProgress.value.total }}{{ backup.desktopActive.value && backup.nativeImageExport ? '（已完成文件会保留）' : '（已开始的下载无法撤销）' }}
          </div>
          <button v-if="backup.imageExportProgress.value" class="btn btn-ghost" type="button" @click="backup.cancelExport()">停止后续图片导出</button>
          <button class="btn btn-ghost" type="button" :disabled="backup.busy.value" @click="pickBackupFile">
            <ArchiveIcon name="upload" />从备份恢复
          </button>
        </div>
        <div class="gallery-backup-group">
          <template v-if="migration.recoveryPending.value">
            <p class="gallery-backup-note is-warn" role="status">迁移激活结果未确认，原资料保持只读。核对只读取本机身份；若无匹配记录，请保留备份并联系维护人员。</p>
            <button class="btn btn-ghost" type="button" :disabled="migration.busy.value" @click="migration.reconcile()">只读核对激活结果</button>
          </template>
          <button v-if="migration.available.value" class="btn btn-ghost" type="button" :disabled="backup.busy.value || migration.busy.value" @click="migration.migrate()"><ArchiveIcon name="upload" />迁移至本机工作区</button>
          <button v-if="migration.available.value" class="btn btn-ghost" type="button" :disabled="backup.busy.value || migration.busy.value" @click="migration.migrate(true)"><ArchiveIcon name="refresh" />继续已备份的迁移</button>
          <div v-if="migration.progress.value" class="gallery-backup-note" role="status" aria-live="polite">{{ migration.progress.value }}</div>
          <button v-if="migration.busy.value" class="btn btn-ghost" type="button" :disabled="!migration.canCancel.value" @click="migration.cancel()">取消迁移</button>
          <button class="btn btn-ghost" type="button" :disabled="backup.busy.value" @click="backup.healthCheck()"><ArchiveIcon name="health" />存储体检</button>
          <button class="btn btn-ghost" type="button" :disabled="backup.busy.value" @click="backup.cleanOrphanImages()"><ArchiveIcon name="broom" />清理未引用图片</button>
        </div>
        <p class="gallery-backup-scope">角色、服装与场景请在<RouterLink to="/scene-manager" @click="panelOpen = false">内容维护</RouterLink>单独导出。</p>
      </div>
    </StudioDialog>

    <StudioDialog
      v-model:open="restoreDialogOpen"
      title="从备份恢复"
      :subtitle="backup.pendingWorkspace.value ? '先创建并核验独立恢复副本，当前工作区继续保留。' : '选择恢复方式。覆盖会替换现有数据，合并会按 id 保留较新的记录。'"
      size="md"
      :closedby="backup.busy.value ? 'none' : 'any'"
      :show-close="!backup.busy.value"
      close-label="取消恢复"
    >
      <div class="gallery-restore-summary">
        <strong>{{ backup.pendingName.value }}</strong>
        <span v-if="backup.pendingWorkspace.value">{{ backup.pendingWorkspace.value.mediaCount }} 个原始媒体 · 备份于 {{ backup.pendingWorkspace.value.createdAt }}</span>
        <span v-else>
          {{ pendingSummary?.history ?? 0 }} 条历史 ·
          {{ pendingSummary?.projects ?? 0 }} 个项目 ·
          {{ pendingSummary?.images ?? 0 }} 张图片 ·
          {{ pendingSummary?.missingImages ? `缺 ${pendingSummary.missingImages} 张原图 · ` : '' }}
          数据版本 v{{ backup.pending.value?.schemaVersion ?? '1.0' }}
        </span>
        <small v-if="pendingSummary?.missingImages" class="gallery-restore-warning">
          缺少的原图不会被伪造关联；对应记录仍会保留并以无图状态恢复。
        </small>
        <p v-if="backup.pendingWorkspace.value && backup.workspaceProgress.value" class="gallery-backup-note" role="status" aria-live="polite">{{ backup.workspaceProgress.value }}</p>
      </div>
      <template #footer>
        <button v-if="backup.pendingWorkspace.value && backup.busy.value" class="btn btn-ghost" type="button" @click="backup.cancelExport()">取消副本校验</button>
        <button class="btn btn-ghost" type="button" :disabled="backup.busy.value" @click="discard">取消</button>
        <button v-if="backup.pendingWorkspace.value" class="btn btn-primary" type="button" :disabled="backup.busy.value" @click="backup.restore('merge')">验证恢复副本</button>
        <template v-else>
          <button class="btn btn-ghost" type="button" :disabled="backup.busy.value" @click="backup.restore('merge')">合并恢复</button>
          <button class="btn btn-danger" type="button" :disabled="backup.busy.value" @click="backup.restore('replace')">覆盖本地</button>
        </template>
      </template>
    </StudioDialog>
  </div>
</template>

<style scoped>
@reference "../../assets/css/tailwind.css";
.gallery-backup-tools { display:inline-flex; align-items:center; gap:var(--s-2); }
.gallery-backup-trigger { position:relative; width:var(--control-height); height:var(--control-height); padding:0; }
.gallery-backup-dot {
  position:absolute; top:6px; right:6px; width:6px; height:6px; border-radius:50%;
  background:var(--warning);
  box-shadow:0 0 0 1.5px var(--bg-surface);
}
.gallery-backup-progress { max-width:260px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.gallery-backup-dialog-body { display:grid; gap:var(--s-3); }
.gallery-backup-group { display:grid; gap:var(--s-2); padding-top:var(--s-2); border-top:1px solid var(--border-soft); }
.gallery-backup-group:first-child { padding-top:0; border-top:0; }
.gallery-backup-group .btn { justify-content:flex-start; }
.gallery-backup-note {
  display:flex; align-items:center; gap:var(--s-2); margin:0; padding:var(--s-2) var(--s-3);
  border:1px solid var(--border-soft); border-radius:var(--r-md); background:var(--bg-base);
  color:var(--text-secondary); font-size:var(--fs-label-sm); line-height:var(--lh-body);
}
.gallery-backup-note.is-warn {
  border-color:color-mix(in srgb,var(--warning) 45%,transparent);
  background:color-mix(in srgb,var(--warning) 10%,transparent);
  color:var(--warning-text);
}
.gallery-backup-scope { margin:0; color:var(--text-secondary); font-size:var(--fs-label-xs); line-height:var(--lh-body); }
.gallery-backup-scope a { color:var(--accent); text-decoration:underline; }
.gallery-restore-summary {
  display:grid; gap:var(--s-2); padding:var(--s-3);
  border:1px solid var(--border-soft); border-radius:var(--r-md); background:var(--bg-base);
  color:var(--text-secondary); font-size:var(--fs-label-sm); line-height:var(--lh-body);
}
.gallery-restore-summary strong { color:var(--text-primary); overflow-wrap:anywhere; }
.gallery-restore-warning { color:var(--warning-text); font-size:var(--fs-label-xs); }
</style>
