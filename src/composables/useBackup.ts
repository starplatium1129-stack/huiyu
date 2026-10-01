import { profileLocalStorage as localStorage, profileDraftStorage as sessionStorage } from '../platform/web/profileStorage.ts'
import { readChatArchive, withChatArchiveMutation } from '@/storage/chatArchiveRepository'
import { CHAT_ARCHIVE_KEY, serializeChatArchive } from '@/utils/chatArchive'
import { withArtworkMutation } from '@/storage/artworkMutation'
import { withArtworkCleanup, assertArtworkCleanupCurrent, readArtworkCleanupImageReferences } from '@/storage/artworkSession'
import { buildBackupBlob, MAX_BACKUP_BYTES, BACKUP_SIZE_MESSAGE, type BackupExportProgress } from '@/utils/backupExport'
import { restoreBackupData } from '@/storage/backupRestore'
import { downloadBlob } from '@/utils/downloadBlob'
import { version as appVersion } from '../../package.json'
import { collectImageReferences, readLocalImageReferences, readSessionImageReferences } from '@/utils/storageReferences'
import { ref, getCurrentInstance, onActivated, onDeactivated, onScopeDispose } from 'vue'
import { confirmAction } from '@/composables/useConfirm'
import { readWebBackupLibrary, readWebBackupCleanup, readWebBackupImages, readWebBackupImage, deleteWebBackupImages } from '../platform/web/profileBackupSource'
import { createWorkspaceBackup, parseWorkspaceBackupReceipt, createWorkspaceRestoreCandidate, workspaceBackupActive, workspaceStorageHealth, collectWorkspaceGarbage, type WorkspaceBackupReceipt } from '../platform/desktop/backupActions'
import { getDesktopWindowRole, onDesktopRuntime } from '../platform/desktop/runtime'
import { registerMaintenanceParticipant } from '../platform/maintenanceParticipants'
import { artworkRepository } from '../storage/artworkRepository'
import {
  normalizeBackup,
  summarizeBackup,
  type BackupFile,
  type BackupSummary,
} from '@/utils/backupCore'
import { inspectStorageHealth, summarizeStorageHealth } from '@/utils/storageHealth'
import {
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
  const pendingWorkspace = ref<WorkspaceBackupReceipt | null>(null)
  let cleanupController: AbortController | null = null
  onScopeDispose(registerMaintenanceParticipant(() => {
    // The initiating atelier cleanup itself is not an unrelated backup writer.
    if ((busy.value && !(cleanupController && getDesktopWindowRole() === 'atelier')) || pending.value || pendingWorkspace.value) throw new Error('BACKUP_BUSY')
  }))
  const desktopActive = ref(workspaceBackupActive())
  const removeRuntimeListener = onDesktopRuntime(() => { desktopActive.value = workspaceBackupActive() })
  onScopeDispose(removeRuntimeListener)
  const pendingName = ref('')
  const lastBackupAt = ref(readLastBackupAt())
  let fileRequest = 0
  const exportProgress = ref<BackupExportProgress | null>(null)
  let exportController: AbortController | null = null
  const imageExportProgress = ref<BackupExportProgress | null>(null)
  let imageExportController: AbortController | null = null
  let disposed = false
  let viewActive = true
  let restoreConfirmation: AbortController | null = null
  function invalidateSelection() {
    fileRequest++
    restoreConfirmation?.abort()
    restoreConfirmation = null
    pending.value = null; pendingWorkspace.value = null; pendingName.value = ''
  }
  if (getCurrentInstance()) {
    onActivated(() => { viewActive = true })
    onDeactivated(() => { viewActive = false; invalidateSelection() })
  }
  const imageDownloadUrls = new Map<string, number>()
  function releaseImageUrl(url: string) {
    window.clearTimeout(imageDownloadUrls.get(url))
    imageDownloadUrls.delete(url)
    URL.revokeObjectURL(url)
  }
  function cancelExport() { exportController?.abort(); imageExportController?.abort() }
  onScopeDispose(() => {
    disposed = true
    invalidateSelection()
    cleanupController?.abort()
    exportController?.abort()
    imageExportController?.abort()
    for (const url of imageDownloadUrls.keys()) releaseImageUrl(url)
  })

  async function exportBackup(): Promise<void> {
    if (busy.value || disposed) return
    busy.value = true
    onFlash('正在整理备份…')
    try {
      const controller = new AbortController()
      exportController = controller
      if (desktopActive.value) {
        const receipt = await createWorkspaceBackup(controller.signal)
        // A native request can finish after its owner or cancel action stopped waiting.
        controller.signal.throwIfAborted()
        downloadBlob(new Blob([JSON.stringify(receipt, null, 2)], { type: 'application/json' }), `huiyu-backup-${receipt.backupId}.json`)
        lastBackupAt.value = Date.now()
        localStorage.setItem(BACKUP_AT_KEY, String(lastBackupAt.value))
        onFlash(`工作区备份已保存，包含 ${receipt.mediaCount} 个原始媒体；恢复凭证已下载。`)
        return
      }
      exportProgress.value = { completed: 0, total: 0 }
      const snapshot = await withArtworkMutation(async () => {
        const [library, images] = await Promise.all([readWebBackupLibrary(), readWebBackupImages()])
        return { ...library, images, settings: await collectSettings() }
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
      if (disposed) return
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
    if (busy.value || disposed) return
    busy.value = true
    const controller = new AbortController()
    imageExportController = controller
    imageExportProgress.value = { completed: 0, total: 0 }
    const desktop = desktopActive.value
    let saved = 0
    let failed = 0
    let completed = 0
    onFlash('正在整理作品图片…')
    try {
      const records = desktop
        ? (await artworkRepository.readHistory()).filter(item => item.image_id).map(item => ({ id: item.image_id!, blob: null,
          name: String(item.title || ''), created_at: Number(item.timestamp) || Date.now() }))
        : await readWebBackupImages()
      if (!controller.signal.aborted) imageExportProgress.value = { completed: 0, total: records.length }
      for (const record of records) {
        if (controller.signal.aborted) break
        try {
          const blob = record.blob instanceof Blob ? record.blob : (record.id ? await (desktop ? artworkRepository.getImage(record.id) : readWebBackupImage(record.id)) : null)
          // Storage reads may not be abortable. Never download their late result after cancellation.
          if (controller.signal.aborted) break
          if (!blob) failed++
          else {
            const url = URL.createObjectURL(blob)
            let anchor: HTMLAnchorElement | undefined
            let started = false
            try {
              anchor = document.createElement('a')
              anchor.href = url
              anchor.download = buildArtworkFileName({
                title: record.name, timestamp: record.created_at, id: record.id,
                ext: (blob.type || 'image/png').split('/')[1] || 'png',
              })
              document.body.appendChild(anchor)
              anchor.click()
              started = true
              saved++
            } finally {
              try { anchor?.remove() } finally {
                // Failed setup releases immediately; successful downloads retain their existing grace period.
                if (started && !disposed) imageDownloadUrls.set(url, window.setTimeout(() => releaseImageUrl(url), 60_000))
                else URL.revokeObjectURL(url)
              }
            }
          }
        } catch { failed++ }
        if (controller.signal.aborted) break
        imageExportProgress.value = { completed: ++completed, total: records.length }
        // Inline blobs and cached reads must yield to the Cancel button between downloads.
        if (completed < records.length) await new Promise<void>(resolve => {
          const finish = () => {
            window.clearTimeout(timer)
            controller.signal.removeEventListener('abort', finish)
            resolve()
          }
          const timer = window.setTimeout(finish, 0)
          controller.signal.addEventListener('abort', finish, { once: true })
        })
      }
      if (!disposed) {
        if (controller.signal.aborted) onFlash(`已停止后续导出；已开始下载 ${saved} 张，浏览器中已开始的下载无法撤销`)
        else if (failed) onFlash(`已开始下载 ${saved} 张；${failed} 张读取或下载失败，请重试`)
        else onFlash(saved
          ? `已开始下载 ${saved} 张作品图片（浏览器可能询问「允许下载多个文件」）`
          : '没有找到可导出的图片')
      }
    } catch (e) {
      if (!disposed) {
        if (controller.signal.aborted) onFlash(`已停止后续导出；已开始下载 ${saved} 张，浏览器中已开始的下载无法撤销`)
        else {
          console.error('export images failed', e)
          onFlash('导出图片失败：' + errorMessage(e, '请检查浏览器存储'))
        }
      }
    } finally {
      imageExportController = null
      imageExportProgress.value = null
      busy.value = false
    }
  }

  async function loadFile(file: File): Promise<BackupSummary | null> {
    if (!file || busy.value || disposed || !viewActive) return null
    invalidateSelection()
    const request = fileRequest
    pending.value = null
    pendingWorkspace.value = null
    pendingName.value = ''
    if (file.size > MAX_BACKUP_BYTES) {
      onFlash(BACKUP_SIZE_MESSAGE)
      return null
    }
    try {
      const raw: unknown = JSON.parse(await file.text())
      if (desktopActive.value) {
        const receipt = parseWorkspaceBackupReceipt(raw)
        if (request !== fileRequest) return null
        pendingWorkspace.value = receipt; pendingName.value = file.name
        return { history: 0, projects: 0, images: receipt.mediaCount, settings: 0 }
      }
      const normalized = normalizeBackup(raw)
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

  function discard() { if (!busy.value) invalidateSelection() }

  async function restore(mode: 'replace' | 'merge'): Promise<boolean> {
    if (busy.value || disposed || !viewActive || restoreConfirmation) return false
    const selected = pending.value
    const workspace = pendingWorkspace.value
    const request = fileRequest
    const current = () => !disposed && viewActive && request === fileRequest
      && pending.value === selected && pendingWorkspace.value === workspace
    if (desktopActive.value) {
      if (!workspace) return false
      busy.value = true
      try {
        const candidate = await createWorkspaceRestoreCandidate(workspace)
        if (current()) {
          invalidateSelection()
          onFlash(`恢复副本已验证：${candidate.candidateId}。当前工作区保持不变，可在维护切换时选择该副本。`)
        }
        return true
      } catch (error) { if (current()) onFlash('恢复校验失败：' + errorMessage(error, '备份不完整')); return false }
      finally { busy.value = false }
    }
    if (!selected) return false
    const replace = mode === 'replace'
    if (replace) {
      const confirmation = new AbortController()
      restoreConfirmation = confirmation
      try {
        const approved = await confirmAction({
          title: '覆盖本地数据？',
          message: `将使用「${pendingName.value}」替换当前历史和项目。原图会保留；建议先导出备份，或改用合并恢复。`,
          confirmLabel: '覆盖', danger: true, signal: confirmation.signal,
        })
        if (!approved || confirmation.signal.aborted || !current() || busy.value) return false
      } finally { if (restoreConfirmation === confirmation) restoreConfirmation = null }
    }
    busy.value = true
    onFlash(replace ? '正在覆盖恢复…' : '正在合并恢复…')
    try {
      // Once accepted, this exact snapshot completes even if its preview closes.
      await restoreBackupData(selected, replace)
      if (current()) {
        invalidateSelection()
        onFlash((replace ? '覆盖' : '合并') + '恢复完成，即将刷新页面…')
      }
      setTimeout(() => window.location.reload(), 700)
      return true
    } catch (e) {
      console.error('backup restore failed', e)
      if (current()) onFlash('恢复失败：' + errorMessage(e, '备份数据无效'))
      return false
    } finally { busy.value = false }
  }

  /** 存储体检：历史条数、图片体积、配额占用 */
  async function healthCheck(): Promise<string> {
    try {
      if (desktopActive.value) { const message = await workspaceStorageHealth(); onFlash(message); return message }
      const [{ history }, images] = await Promise.all([readWebBackupLibrary(), readWebBackupImages()])
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
    const { history, projects, trash, quarantine, images } = await readWebBackupCleanup()
    const referenced = collectImageReferences([history, projects, trash, quarantine, ...readLocalImageReferences(localStorage), ...readSessionImageReferences(sessionStorage), ...readArtworkCleanupImageReferences()])
    return { referenced, images }
  }

  /** Confirmation authorizes only these IDs, never later-created images. Acquire
   * exclusive document access, then the existing writer lock, and rescan before
   * deleting. Other tabs' session-only drafts cannot be safely guessed at.
   */
  async function cleanOrphanImages(): Promise<number> {
    if (busy.value || disposed) return 0
    busy.value = true
    const controller = new AbortController()
    cleanupController = controller
    try {
      if (desktopActive.value) {
        const removed = await collectWorkspaceGarbage()
        onFlash(`已清理 ${removed} 个过期且无引用的媒体对象。`)
        return removed
      }
      const snapshot = await readCleanupState()
      const candidates = new Set(snapshot.images.filter(record => !snapshot.referenced.has(record.id)).map(record => record.id))
      if (!candidates.size) { onFlash('没有需要清理的孤儿图片'); return 0 }
      if (!(await confirmAction({
        title: `清理 ${candidates.size} 张未引用图片`,
        message: '请先备份并保存草稿，完成其他窗口的生成与保存操作。确认后会重新检查引用；新保存或新建的图片不会按旧名单删除。',
        confirmLabel: '继续清理',
        danger: true,
      }))) return 0
      const removed = await withArtworkCleanup(async () => {
        const current = await readCleanupState()
        controller.signal.throwIfAborted()
        const ids = current.images.filter(record => candidates.has(record.id) && !current.referenced.has(record.id)).map(record => record.id)
        assertArtworkCleanupCurrent()
        if (ids.length) await deleteWebBackupImages(ids)
        return ids.length
      }, controller.signal)
      onFlash(removed ? `已清理 ${removed} 张孤儿图片` : '图片引用已变化，无需清理；原图均已保留')
      return removed
    } catch (e) {
      onFlash('清理失败：' + errorMessage(e, '请重试'))
      return 0
    } finally {
      cleanupController = null
      busy.value = false
    }
  }

  return { busy, desktopActive, exportProgress, imageExportProgress, cancelExport, pending, pendingWorkspace, pendingName, lastBackupAt, exportBackup, exportImages, loadFile, discard, restore, healthCheck, cleanOrphanImages }
}
