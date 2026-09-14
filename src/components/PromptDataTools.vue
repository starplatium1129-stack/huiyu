<template>
  <details ref="utilityEl" class="utility-menu">
    <summary
      class="utility-trigger"
      :aria-label="backupStale ? `数据工具（${backupReminder}）` : '数据工具'"
      :title="backupStale ? `数据工具（${backupReminder}）` : '数据工具与蓝图'"
    >
      <span class="utility-trigger-dots" aria-hidden="true">···</span>
      <span v-if="backupStale" class="utility-dot" aria-hidden="true"></span>
    </summary>
    <div class="utility-popover">
      <div v-if="backupStale" class="utility-note" role="status">
        <ArchiveIcon name="health" /> {{ backupReminder }}
      </div>
      <div class="utility-label">本地数据</div>
      <div class="utility-actions">
        <button class="btn btn-ghost wide" type="button" :disabled="backup.busy.value" @click="backup.exportBackup()"
          title="导出 JSON 恢复文件（含全部图片数据），用于日后「从备份恢复」">
          <ArchiveIcon name="download" /> 导出备份 JSON
        </button>
        <button class="btn btn-ghost wide" type="button" :disabled="backup.busy.value" @click="backup.exportImages()"
          title="把作品册的每张原图下载成独立的图片文件">
          <ArchiveIcon name="image" /> 导出作品图片
        </button>
        <button class="btn btn-ghost wide" type="button" :disabled="backup.busy.value" @click="pickBackupFile">
          <ArchiveIcon name="upload" /> 从备份恢复
        </button>
        <input ref="backupFileEl" class="sr-only pb-backup-file-input" type="file" accept="application/json" @change="onBackupFilePicked" />
      </div>
      <div class="utility-divider"></div>
      <div class="utility-label">创作蓝图</div>
      <div class="utility-actions">
        <button class="btn btn-ghost wide" type="button" @click="exportBlueprint"
          title="将当前导演台的所有场景、故事、提示词与出图参数导出为独立 Blueprint JSON">
          <ArchiveIcon name="spark" /> 导出当前蓝图 JSON
        </button>
        <button class="btn btn-ghost wide" type="button" @click="pickBlueprintFile"
          title="从 Blueprint JSON 导入并回填导演台配置">
          <ArchiveIcon name="upload" /> 导入蓝图配置
        </button>
        <input ref="blueprintFileEl" class="sr-only pb-blueprint-file-input" type="file" accept="application/json" @change="onBlueprintFilePicked" />
      </div>
      <div class="utility-divider"></div>
      <div class="utility-label">存储维护</div>
      <div class="utility-actions">
        <button class="btn btn-ghost wide" type="button" :disabled="backup.busy.value" @click="backup.healthCheck()"><ArchiveIcon name="health" /> 存储体检</button>
        <button class="btn btn-ghost wide" type="button" :disabled="backup.busy.value" @click="backup.cleanOrphanImages()"><ArchiveIcon name="broom" /> 清理孤儿图片</button>
      </div>
    </div>
  </details>

  <Teleport to="body">
    <FluidTransition>
    <div v-if="backup.pending.value" class="pb-backup-overlay open" @click.self="discard">
      <div
        ref="backupCardEl"
        class="pb-backup-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="backup-restore-title"
      >
        <h3 id="backup-restore-title">从备份恢复</h3>
        <p>选择恢复方式。覆盖会替换现有数据，合并会按 id 保留较新的记录。</p>
        <div class="pb-backup-summary">
          <strong>{{ backup.pendingName.value }}</strong>
          <span>
            {{ pendingSummary?.history ?? 0 }} 条历史 ·
            {{ pendingSummary?.projects ?? 0 }} 个项目 ·
            {{ pendingSummary?.images ?? 0 }} 张图片 ·
            数据版本 v{{ backup.pending.value.schemaVersion }}
          </span>
        </div>
        <div class="pb-backup-actions">
          <button class="btn btn-ghost" type="button" :disabled="backup.busy.value" @click="discard">取消</button>
          <button class="btn btn-ghost" type="button" :disabled="backup.busy.value" @click="backup.restore('merge')">合并恢复</button>
          <button class="btn btn-danger" type="button" :disabled="backup.busy.value" @click="restoreReplace">覆盖本地</button>
        </div>
      </div>
    </div>
    </FluidTransition>
  </Teleport>
</template>

<script setup lang="ts">
import FluidTransition from '@/components/visual/FluidTransition.vue'
import { downloadBlob } from "@/utils/downloadBlob"
import { ref, computed } from 'vue'
import { useBackup, type BackupSummary } from '@/composables/useBackup'
import { confirmAction } from '@/composables/useConfirm'
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
const backupCardEl = ref<HTMLElement | null>(null)
const backupFileEl = ref<HTMLInputElement | null>(null)
const blueprintFileEl = ref<HTMLInputElement | null>(null)
const utilityEl = ref<HTMLDetailsElement | null>(null)
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

useFocusTrap(backupCardEl, () => backup.pending.value !== null, {
  onEscape: () => { if (!backup.busy.value) discard() },
})

function pickBackupFile() {
  backupFileEl.value?.click()
}

function pickBlueprintFile() {
  blueprintFileEl.value?.click()
}

function exportBlueprint() {
  if (!props.blueprintData) {
    emit('flash', '当前没有可导出的蓝图数据')
    return
  }
  const payload = {
    schema: 'aics-director-blueprint-v1',
    exportedAt: Date.now(),
    ...props.blueprintData,
  }
  const json = JSON.stringify(payload, null, 2)
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16)
  downloadBlob(blob, `aics-blueprint-${stamp}.json`)
  emit('flash', '蓝图 JSON 已导出')
  if (utilityEl.value) utilityEl.value.open = false
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
      emit('flash', '蓝图配置已成功载入')
    } else {
      emit('flash', '无效的蓝图文件格式')
    }
  } catch {
    emit('flash', '读取蓝图 JSON 失败')
  }
  input.value = ''
  if (utilityEl.value) utilityEl.value.open = false
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
  if (utilityEl.value) utilityEl.value.open = false
}
</script>

<style scoped>
.utility-trigger { position: relative; }
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
