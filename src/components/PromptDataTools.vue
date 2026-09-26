<template>
  <div class="utility-menu">
  <StudioPopover v-model:open="utilityOpen" label="数据工具" content-class="studio-data-tools"
    @close-auto-focus="onMenuCloseAutoFocus">
    <template #trigger>
      <button type="button" @focus="utilityTrigger = $event.currentTarget as HTMLButtonElement"
        class="utility-trigger"
        :aria-label="backupStale ? `数据工具（${backupReminder}）` : '数据工具'"
      >
        <span class="utility-trigger-dots" aria-hidden="true">···</span>
        <span v-if="backupStale" class="utility-dot" aria-hidden="true"></span>
      </button>
    </template>
    <div class="utility-heading">数据工具<button type="button" class="btn btn-ghost btn-icon" aria-label="关闭数据工具" @click="utilityOpen = false"><ArchiveIcon name="close" /></button></div>
      <div v-if="backupStale" class="utility-note" role="status">
        <ArchiveIcon name="health" /> {{ backupReminder }}
      </div>
      <div class="utility-label">本地数据</div>
      <div class="utility-actions">
        <StudioTooltip anchor :content="backup.desktopActive.value ? '完整备份保存在本机工作区，并下载恢复凭证' : '导出 JSON 恢复文件（含全部图片数据），用于日后「从备份恢复」'">
          <button class="btn btn-ghost wide" type="button" :disabled="backup.busy.value" @click="backup.exportBackup()">
            <ArchiveIcon name="download" /> {{ backup.desktopActive.value ? '创建工作区备份' : '导出备份 JSON' }}
          </button>
        </StudioTooltip>
        <div v-if="backup.exportProgress.value" class="utility-note wide" role="status" aria-live="polite">
          正在备份图片：{{ backup.exportProgress.value.completed }} / {{ backup.exportProgress.value.total }}
        </div>
        <button v-if="backup.exportProgress.value" class="btn btn-ghost wide" type="button" @click="backup.cancelExport()">取消备份</button>
        <StudioTooltip anchor content="把作品册的每张原图下载成独立的图片文件">
          <button class="btn btn-ghost wide" type="button" :disabled="backup.busy.value" @click="backup.exportImages()">
            <ArchiveIcon name="image" /> 导出作品图片
          </button>
        </StudioTooltip>
        <button class="btn btn-ghost wide" type="button" :disabled="backup.busy.value" @click="pickBackupFile">
          <ArchiveIcon name="upload" /> 从备份恢复
        </button>
      </div>
      <div class="utility-divider"></div>
      <div class="utility-label">创作蓝图</div>
      <div class="utility-actions">
        <StudioTooltip content="将当前工作台的所有场景、故事、提示词与出图参数导出为独立蓝图配置文件">
          <button class="btn btn-ghost wide" type="button" @click="exportBlueprint">
            <ArchiveIcon name="spark" /> 导出当前蓝图 JSON
          </button>
        </StudioTooltip>
        <StudioTooltip content="从蓝图配置文件导入并回填工作台设置">
          <button class="btn btn-ghost wide" type="button" @click="pickBlueprintFile">
            <ArchiveIcon name="upload" /> 导入蓝图配置
          </button>
        </StudioTooltip>
      </div>
      <div class="utility-divider"></div>
      <div class="utility-label">存储维护</div>
      <div class="utility-actions">
        <button v-if="migration.available.value" class="btn btn-ghost wide" type="button" :disabled="backup.busy.value || migration.busy.value" @click="migration.migrate()"><ArchiveIcon name="upload" /> 迁移至本机工作区</button>
        <button v-if="migration.available.value" class="btn btn-ghost wide" type="button" :disabled="backup.busy.value || migration.busy.value" @click="migration.migrate(true)"><ArchiveIcon name="refresh" /> 继续已备份的迁移</button>
        <StudioTooltip v-if="migration.bundledAvailable.value" anchor :content="migration.bundledVerified.value ? '完成备份核对后，下次启动使用程序内置界面' : '此版本尚未完成桌面启动验收，继续使用当前入口'">
          <button class="btn btn-ghost wide" type="button" :disabled="backup.busy.value || migration.busy.value || !migration.bundledVerified.value" @click="migration.enableBundled()"><ArchiveIcon name="spark" /> 启用独立启动界面</button>
        </StudioTooltip>
        <div v-if="migration.progress.value" class="utility-note wide" role="status" aria-live="polite">{{ migration.progress.value }}</div>
        <button v-if="migration.busy.value" class="btn btn-ghost wide" type="button" @click="migration.cancel()">取消迁移</button>
        <button class="btn btn-ghost wide" type="button" :disabled="backup.busy.value" @click="backup.healthCheck()"><ArchiveIcon name="health" /> 存储体检</button>
        <button class="btn btn-ghost wide" type="button" :disabled="backup.busy.value" @click="cleanOrphanImages"><ArchiveIcon name="broom" /> 清理未引用图片</button>
      </div>
  </StudioPopover>
  </div>
  <!-- File pickers stay mounted when the anchored panel closes during native selection. -->
  <input ref="backupFileEl" class="sr-only pb-backup-file-input" type="file" accept="application/json" tabindex="-1" @change="onBackupFilePicked" />
  <input ref="blueprintFileEl" class="sr-only pb-blueprint-file-input" type="file" accept="application/json" tabindex="-1" @change="onBlueprintFilePicked" />

  <Teleport to="body">
    <FluidTransition>
    <div v-if="backup.pending.value || backup.pendingWorkspace.value" class="pb-backup-overlay open" @click.self="discard">
      <div
        ref="backupCardEl"
        class="pb-backup-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="backup-restore-title"
      >
        <h3 id="backup-restore-title">从备份恢复</h3>
        <p v-if="backup.pendingWorkspace.value">先创建并核验独立恢复副本，当前工作区继续保留。</p>
        <p v-else>选择恢复方式。覆盖会替换现有数据，合并会按 id 保留较新的记录。</p>
        <div class="pb-backup-summary">
          <strong>{{ backup.pendingName.value }}</strong>
          <span v-if="backup.pendingWorkspace.value">{{ backup.pendingWorkspace.value.mediaCount }} 个原始媒体 · 备份于 {{ backup.pendingWorkspace.value.createdAt }}</span>
          <span v-else>
            {{ pendingSummary?.history ?? 0 }} 条历史 ·
            {{ pendingSummary?.projects ?? 0 }} 个项目 ·
            {{ pendingSummary?.images ?? 0 }} 张图片 ·
            {{ pendingSummary?.missingImages ? `缺 ${pendingSummary.missingImages} 张原图 · ` : '' }}
            数据版本 v{{ backup.pending.value?.schemaVersion ?? '1.0' }}
          </span>
          <small v-if="pendingSummary?.missingImages" class="pb-backup-warning">
            缺少的原图不会被伪造关联；对应记录仍会保留并以无图状态恢复。
          </small>
        </div>
        <div class="pb-backup-actions">
          <button class="btn btn-ghost" type="button" :disabled="backup.busy.value" @click="discard">取消</button>
          <button v-if="backup.pendingWorkspace.value" class="btn btn-ghost" type="button" :disabled="backup.busy.value" @click="backup.restore('merge')">验证恢复副本</button>
          <template v-else><button class="btn btn-ghost" type="button" :disabled="backup.busy.value" @click="backup.restore('merge')">合并恢复</button>
          <button class="btn btn-danger" type="button" :disabled="backup.busy.value" @click="restoreReplace">覆盖本地</button></template>
        </div>
      </div>
    </div>
    </FluidTransition>
  </Teleport>
</template>

<script setup lang="ts">
import FluidTransition from '@/components/visual/FluidTransition.vue'
import StudioPopover from '@/components/ui/StudioPopover.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import { downloadBlob } from "@/utils/downloadBlob"
import { ref, computed, watch } from 'vue'
import { useBackup, type BackupSummary } from '@/composables/useBackup'
import { useWorkspaceMigration } from '@/composables/useWorkspaceMigration'
import { confirmAction, useConfirmState } from '@/composables/useConfirm'
import { useFocusTrap } from '@/composables/useFocusTrap'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import '@/assets/css/director/components/PromptDataTools.css'

const props = defineProps<{
  blueprintData?: Record<string, unknown>
}>()

const emit = defineEmits<{
  flash: [message: string]
  loadBlueprint: [data: Record<string, unknown>]
}>()

const backup = useBackup((message) => emit('flash', message))
const migration = useWorkspaceMigration(message => emit('flash', message))
const backupCardEl = ref<HTMLElement | null>(null)
const backupFileEl = ref<HTMLInputElement | null>(null)
const blueprintFileEl = ref<HTMLInputElement | null>(null)
const utilityOpen = ref(false)
const utilityTrigger = ref<HTMLButtonElement | null>(null)
const confirmation = useConfirmState()
const pendingSummary = ref<BackupSummary | null>(null)
let backupFileVersion = 0

/** 超过 7 天未备份（或从未备份）时在触发器上亮角标，菜单内给提示 */
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

const { returnFocus } = useFocusTrap(backupCardEl, () => backup.pending.value !== null || backup.pendingWorkspace.value !== null, {
  onEscape: () => { if (!backup.busy.value) discard() },
})
watch(() => backup.pending.value || backup.pendingWorkspace.value, pending => {
  if (pending) returnFocus.value = utilityTrigger.value
}, { flush:'post' })

function pickBackupFile() {
  backupFileEl.value?.click()
}

function pickBlueprintFile() {
  blueprintFileEl.value?.click()
}

function onMenuCloseAutoFocus(event: Event) {
  // A restore preview or confirmation owns focus while it is open.
  if (backup.pending.value || backup.pendingWorkspace.value || confirmation.value.visible) event.preventDefault()
}

function cleanOrphanImages() {
  utilityOpen.value = false
  utilityTrigger.value?.focus()
  void backup.cleanOrphanImages()
}

function exportBlueprint() {
  if (!props.blueprintData) {
    emit('flash', '当前没有可导出的蓝图数据')
    return
  }
  const payload = {
    ...props.blueprintData,
    schema: 'aics-director-blueprint-v1',
    exportedAt: Date.now(),
  }
  const json = JSON.stringify(payload, null, 2)
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16)
  downloadBlob(blob, `aics-blueprint-${stamp}.json`)
  emit('flash', '蓝图 JSON 已导出')
  utilityOpen.value = false
}

async function onBlueprintFilePicked(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  try {
    const text = await file.text()
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object') {
      emit('loadBlueprint', parsed as Record<string, unknown>)
    } else {
      emit('flash', '无效的蓝图文件格式')
    }
  } catch {
    emit('flash', '读取蓝图 JSON 失败')
  }
  input.value = ''
  utilityOpen.value = false
}

function discard() {
  if (backup.busy.value) return
  backupFileVersion++
  backup.discard()
  pendingSummary.value = null
}

/**
 * 覆盖式恢复（2026-08-30 UX 审计 P1）。
 *
 * 「覆盖本地」会替换全部历史、项目与图片，而此前只需单击即执行——弹窗正文
 * 里那句「覆盖会替换现有数据」只是说明，不是确认。误点一次等于清空本地
 * 作品库，且没有撤销通道（备份恢复不走软删，回收站兜不住它）。
 *
 * 合并恢复不拦：它按 id 保留较新的记录，不会丢东西，每次都弹问反而会让
 * 用户养成无脑确认的习惯。
 */
async function restoreReplace() {
  if (backup.busy.value) return
  const count = pendingSummary.value?.history ?? 0
  const ok = await confirmAction({
    title: '覆盖本地数据？',
    message: `当前 ${count} 条历史和项目将被替换。原图会保留，确认恢复结果后可通过存储清理释放空间。建议先导出备份，或改用合并恢复。`,
    confirmLabel: '覆盖',
    danger: true,
  })
  if (!ok) return
  await backup.restore('replace', true)
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
  utilityOpen.value = false
}
</script>

<style scoped>
.utility-trigger { position: relative; }
.utility-heading { display:flex; align-items:center; justify-content:space-between; gap:var(--s-3); margin-bottom:var(--s-3); color:var(--text-primary); font-weight:600; }
.utility-label { margin:var(--s-3) 0 var(--s-2); color:var(--text-muted); font:600 var(--fs-label-sm)/var(--lh-body) var(--font-sans); }
.utility-actions { display:grid; gap:var(--s-1); }
.utility-actions .btn { justify-content:flex-start; min-height:44px; padding:var(--s-2) var(--s-3); font-size:var(--fs-label); }
.utility-actions .btn:not(:disabled) { border-color:transparent; }
.utility-actions .btn:hover:not(:disabled) { background:var(--bg-hover); color:var(--text-primary); }
.utility-divider { height:1px; margin:var(--s-3) 0; background:var(--border-soft); }
.utility-trigger-dots {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
  letter-spacing: 0.08em;
  margin-top: -2px;
}
.utility-dot {
  position: absolute; top: 3px; right: 3px;
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--warning);
  box-shadow: 0 0 0 1.5px var(--bg-surface), 0 0 6px color-mix(in srgb, var(--warning) 60%, transparent);
}
.utility-note {
  display: flex; align-items: center; gap: var(--s-2);
  margin-bottom: var(--s-3); padding: var(--s-2) var(--s-3);
  border: 1px solid color-mix(in srgb, var(--warning) 45%, transparent);
  border-radius: var(--r-md);
  background: color-mix(in srgb, var(--warning) 10%, transparent);
  color: var(--warning-text);
  font-size: var(--fs-label);
}
</style>
