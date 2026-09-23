import { readChatArchive, withChatArchiveMutation } from '@/storage/chatArchiveRepository'
import { CHAT_ARCHIVE_KEY, serializeChatArchive } from '@/utils/chatArchive'
import { withArtworkMutation } from '@/storage/artworkMutation'
import { withArtworkCleanup } from '@/storage/artworkSession'
import { buildBackupBlob, MAX_BACKUP_BYTES, BACKUP_SIZE_MESSAGE, type BackupExportProgress } from '@/utils/backupExport'
import { restoreBackupData } from '@/storage/backupRestore'
import { downloadBlob } from '@/utils/downloadBlob'
import { version as appVersion } from '../../package.json'
import { collectImageReferences, readLocalImageReferences, readSessionImageReferences } from '@/utils/storageReferences'
import { ref } from 'vue'
import { confirmAction } from '@/composables/useConfirm'
import { kvGet } from '@/composables/useKVStore'
import { imgList, imgGet, imgDeleteMany } from '@/composables/useImageStore'
import {
  normalizeBackup,
  summarizeBackup,
  type BackupFile,
  type BackupRecord,
  type BackupSummary,
} from '@/utils/backupCore'
import { inspectStorageHealth, summarizeStorageHealth } from '@/utils/storageHealth'
import {
  ARTWORK_HISTORY_KV_KEY,
  ARTWORK_PROJECTS_KV_KEY,
  ARTWORK_TRASH_KV_KEY,
  ARTWORK_HISTORY_QUARANTINE_KEY,
  BACKUP_AT_KEY,
  cleanDeadLocalKeys,
  collectLiveLocalSettings,
} from '@/utils/storageKeys'
import { buildArtworkFileName } from '@/utils/artworkFileName'
export type { BackupSummary } from '@/utils/backupCore'

/**
 * 本地数据备份 / 恢复 — 从重构前 tools/prompt-builder/backup.js 迁移。
 * 备份内容：作品历史、项目、出图设置、IndexedDB 图片（base64 内联）。
 */

// 键名统一出处：src/utils/storageKeys.ts
const HISTORY_KEY = ARTWORK_HISTORY_KV_KEY
const PROJECT_KEY = ARTWORK_PROJECTS_KV_KEY

// 备份时间戳键（BACKUP_AT_KEY）已登记在 storageKeys.ts：
// 活键但刻意不参与备份导出，恢复时不覆盖新环境的时间戳。

export function readLastBackupAt(): number {
  try {
    const value = Number(localStorage.getItem(BACKUP_AT_KEY))
    return Number.isFinite(value) && value > 0 ? value : 0
  } catch { return 0 }
}


async function collectSettings(): Promise<Record<string, string>> {
  // 活键统一登记在 src/utils/storageKeys.ts：精确键 + 训练动态前缀。
  return { ...collectLiveLocalSettings(localStorage), [CHAT_ARCHIVE_KEY]: serializeChatArchive(await withChatArchiveMutation(() => readChatArchive())) }
}

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error.message
  return String(error ?? '').trim() || fallback
}

export function useBackup(onFlash: (msg: string) => void = () => {}) {
  const busy = ref(false)
  const pending = ref<BackupFile | null>(null)
  const pendingName = ref('')
  const lastBackupAt = ref(readLastBackupAt())
  let fileRequest = 0
  const exportProgress = ref<BackupExportProgress | null>(null)
  let exportController: AbortController | null = null
  function cancelExport() { exportController?.abort() }

  async function exportBackup(): Promise<void> {
    if (busy.value) return
    busy.value = true
    onFlash('正在整理备份…')
    try {
      const controller = new AbortController()
      exportController = controller
      exportProgress.value = { completed: 0, total: 0 }
      const snapshot = await withArtworkMutation(async () => {
        const [history, projects, images] = await Promise.all([
          kvGet<BackupRecord[]>(HISTORY_KEY), kvGet<BackupRecord[]>(PROJECT_KEY), imgList(),
        ])
        if ((history !== null && !Array.isArray(history)) || (projects !== null && !Array.isArray(projects))) {
          throw new Error('作品记录格式异常，已停止导出，未丢弃损坏记录')
        }
        return { history: history ?? [], projects: projects ?? [], images, settings: await collectSettings() }
      })
      const { blob, summary: info } = await buildBackupBlob({
        appVersion, createdAt: new Date().toISOString(), history: snapshot.history,
        projects: snapshot.projects, settings: snapshot.settings,
      }, snapshot.images, {
        signal: controller.signal,
        onProgress: progress => { exportProgress.value = progress },
      })
      // Only a complete, importable backup may cause timestamp/dead-key updates.
      if (controller.signal.aborted) throw new DOMException('已取消备份', 'AbortError')
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16)
      downloadBlob(blob, `aics-backup-${stamp}.json`)
      const removedDead = cleanDeadLocalKeys(localStorage)
      lastBackupAt.value = Date.now()
      try { localStorage.setItem(BACKUP_AT_KEY, String(lastBackupAt.value)) } catch {}
      onFlash(`备份完成：${info.history} 条记录 · ${info.images} 张图片 · ${Math.max(1, Math.round(blob.size / 1024))} KB`
        + (removedDead ? ` · 已清理 ${removedDead} 个废弃存储键` : ''))
    } catch (e) {
      if (exportController?.signal.aborted) onFlash('已取消备份，未生成文件，原有作品未改动')
      else {
        console.error('backup export failed', e)
        onFlash('备份失败：' + errorMessage(e, '请检查浏览器存储'))
      }
    } finally {
      exportController = null
      exportProgress.value = null
      busy.value = false
    }
  }

  /**
   * 导出作品图片：把 IndexedDB 里的原图逐个下载成文件。
   * 与导出备份（JSON 恢复包）不同，这里导出的是可以直接使用的图片。
   */
  async function exportImages(): Promise<void> {
    if (busy.value) return
    busy.value = true
    onFlash('正在整理作品图片…')
    try {
      const records = (await imgList()) || []
      let saved = 0
      let failed = 0
      for (const record of records) {
        try {
          const blob = record.blob instanceof Blob ? record.blob : (record.id ? await imgGet(record.id) : null)
          if (!blob) { failed++; continue }
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          const ext = (blob.type || 'image/png').split('/')[1] || 'png'
          a.href = url
          // 2026-09-01 文件名去重：name 相同的多张图旧方案直接撞名，
          // 改用统一生成器，带时间戳与 id 尾号保证唯一（见 utils/artworkFileName.ts）。
          a.download = buildArtworkFileName({
            title: record.name,
            timestamp: record.created_at,
            id: record.id,
            ext,
          })
          document.body.appendChild(a)
          a.click()
          a.remove()
          // 大图下载完成后才释放 blob URL，避免下载中断
          window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
          saved++
        } catch { failed++ }
      }
      onFlash(saved
        ? `已开始下载 ${saved} 张作品图片（浏览器可能询问「允许下载多个文件」）`
        : '没有找到可导出的图片')
      if (failed) onFlash(`已开始下载 ${saved} 张；${failed} 张读取或下载失败，请重试`)
    } catch (e) {
      console.error('export images failed', e)
      onFlash('导出图片失败：' + errorMessage(e, '请检查浏览器存储'))
    } finally {
      busy.value = false
    }
  }

  async function loadFile(file: File): Promise<BackupSummary | null> {
    if (!file || busy.value) return null
    const request = ++fileRequest
    pending.value = null
    pendingName.value = ''
    if (file.size > MAX_BACKUP_BYTES) {
      onFlash(BACKUP_SIZE_MESSAGE)
      return null
    }
    try {
      const normalized = normalizeBackup(JSON.parse(await file.text()))
      if (request !== fileRequest) return null
      pending.value = normalized
      pendingName.value = file.name
      return summarizeBackup(pending.value)
    } catch (e) {
      if (request !== fileRequest) return null
      pending.value = null
      pendingName.value = ''
      onFlash('无法读取备份：' + errorMessage(e, '文件已损坏'))
      return null
    }
  }

  function discard() { if (busy.value) return; fileRequest++; pending.value = null; pendingName.value = '' }

  async function restore(mode: 'replace' | 'merge', confirmed = false): Promise<boolean> {
    if (!pending.value || busy.value) return false
    const replace = mode === 'replace'
    if (replace && !confirmed && !(await confirmAction({
      title: '覆盖恢复会替换当前项目与历史记录',
      message: '原图保留；确认恢复后可通过存储清理释放空间。',
      confirmLabel: '继续覆盖恢复',
      danger: true,
    }))) {
      return false
    }
    busy.value = true
    onFlash(replace ? '正在覆盖恢复…' : '正在合并恢复…')
    try {
      await restoreBackupData(pending.value, replace)

      pending.value = null
      pendingName.value = ''
      onFlash((replace ? '覆盖' : '合并') + '恢复完成，即将刷新页面…')
      setTimeout(() => window.location.reload(), 700)
      return true
    } catch (e) {
      console.error('backup restore failed', e)
      onFlash('恢复失败：' + errorMessage(e, '备份数据无效'))
      return false
    } finally {
      busy.value = false
    }
  }

  /** 存储体检：历史条数、图片体积、配额占用 */
  async function healthCheck(): Promise<string> {
    try {
      const [history, images] = await Promise.all([kvGet<BackupRecord[]>(HISTORY_KEY), imgList()])
      const bytes = (images || []).reduce((sum, r) => sum + (Number(r.size) || 0), 0)
      const mb = (bytes / 1024 / 1024).toFixed(1)

      let quota: StorageEstimate | null = null
      try {
        quota = await navigator.storage?.estimate?.() || null
      } catch {}

      const report = inspectStorageHealth(history, images, { quota })
      const msg = `存储体检：${summarizeStorageHealth(report)} · 图片 ${mb} MB`
        + (report.ok && !report.orphanImageIds.length ? ' · 正常' : '')
      onFlash(msg)
      return msg
    } catch (e) {
      onFlash('存储体检失败：' + errorMessage(e, '请检查浏览器存储'))
      return ''
    }
  }

  async function readCleanupState() {
    const [history, projects, trash, quarantine, images] = await Promise.all([
      kvGet(HISTORY_KEY), kvGet(PROJECT_KEY), kvGet(ARTWORK_TRASH_KV_KEY), kvGet(ARTWORK_HISTORY_QUARANTINE_KEY), imgList(),
    ])
    const referenced = collectImageReferences([history, projects, trash, quarantine, ...readLocalImageReferences(localStorage), ...readSessionImageReferences(sessionStorage)])
    return { referenced, images }
  }

  /** Confirmation authorizes only these IDs, never later-created images. Acquire
   * exclusive document access, then the existing writer lock, and rescan before
   * deleting. Other tabs' session-only drafts cannot be safely guessed at.
   */
  async function cleanOrphanImages(): Promise<number> {
    if (busy.value) return 0
    busy.value = true
    try {
      const snapshot = await readCleanupState()
      const candidates = new Set(snapshot.images.filter(record => !snapshot.referenced.has(record.id)).map(record => record.id))
      if (!candidates.size) { onFlash('没有需要清理的孤儿图片'); return 0 }
      if (!(await confirmAction({
        title: `清理 ${candidates.size} 张未引用图片`,
        message: '请先备份，并保存草稿、关闭其他绘遇窗口。确认后会重新检查引用；新保存或新建的图片不会按旧名单删除。',
        confirmLabel: '继续清理',
        danger: true,
      }))) return 0
      const removed = await withArtworkCleanup(async () => {
        const current = await readCleanupState()
        const ids = current.images.filter(record => candidates.has(record.id) && !current.referenced.has(record.id)).map(record => record.id)
        if (ids.length) await imgDeleteMany(ids)
        return ids.length
      })
      onFlash(removed ? `已清理 ${removed} 张孤儿图片` : '图片引用已变化，无需清理；原图均已保留')
      return removed
    } catch (e) {
      onFlash('清理失败：' + errorMessage(e, '请重试'))
      return 0
    } finally {
      busy.value = false
    }
  }

  return { busy, exportProgress, cancelExport, pending, pendingName, lastBackupAt, exportBackup, exportImages, loadFile, discard, restore, healthCheck, cleanOrphanImages }
}
