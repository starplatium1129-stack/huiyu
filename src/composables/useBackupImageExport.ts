import { onScopeDispose, ref, type Ref } from 'vue'
import type { BackupExportProgress } from '@/utils/backupExport'
import { buildArtworkFileName } from '@/utils/artworkFileName'
import { readWebBackupImage } from '../platform/web/profileBackupSource'
import { captureBackupSource } from './backupSource'
import { hostApi } from '@/platform/desktop/hostApi'

interface BackupImageExportOptions {
  busy: Ref<boolean>
  desktopActive: Readonly<Ref<boolean>>
  onFlash: (message: string) => void
}

/** Owns image downloads and URL lifetimes; backup/restore share the caller's busy gate. */
export function useBackupImageExport({ busy, desktopActive, onFlash }: BackupImageExportOptions) {
  const imageExportProgress = ref<BackupExportProgress | null>(null)
  let imageExportController: AbortController | null = null
  let disposed = false
  const nativeImageExport = Boolean(hostApi())
  const imageDownloadUrls = new Map<string, { timer: number; bytes: number }>()
  let downloadBytes = 0
  function releaseImageUrl(url: string) {
    const pending = imageDownloadUrls.get(url)
    window.clearTimeout(pending?.timer)
    downloadBytes -= pending?.bytes ?? 0
    imageDownloadUrls.delete(url)
    URL.revokeObjectURL(url)
  }
  function cancelExport() { imageExportController?.abort() }
  // Deactivation keeps exports running; disposal cancels and releases their URLs.
  onScopeDispose(() => {
    disposed = true
    cancelExport()
    for (const url of imageDownloadUrls.keys()) releaseImageUrl(url)
  })

  /** 导出可直接使用的作品原图，而非 JSON 恢复包。 */
  async function exportImages(): Promise<void> {
    if (busy.value || disposed) return
    busy.value = true
    const controller = new AbortController()
    imageExportController = controller
    imageExportProgress.value = { completed: 0, total: 0 }
    const desktop = desktopActive.value
    const source = captureBackupSource(controller, desktop), { repository, check } = source
    const pause = (milliseconds: number) => new Promise<void>(resolve => {
      const finish = () => { window.clearTimeout(timer); controller.signal.removeEventListener('abort',finish); resolve() }
      const timer = window.setTimeout(finish,milliseconds)
      controller.signal.addEventListener('abort',finish,{ once:true })
      if (controller.signal.aborted) finish()
    })
    let saved = 0
    let failed = 0
    let completed = 0
    onFlash('正在整理作品图片…')
    try {
      check()
      if (desktop && nativeImageExport) {
        const { exportArtworkImages } = await import('@/platform/desktop/artworkImageExport')
        const message = await exportArtworkImages(controller.signal, value => { if (!disposed) imageExportProgress.value = value })
        if (!disposed) onFlash(message)
        return
      }
      const { backupImagePages } = await import('./backupImagePages')
      check()
      for await (const { entries, total } of backupImagePages(desktop,controller.signal)) for (const record of entries) {
        imageExportProgress.value = { completed, total }
        check()
        try {
          const blob = record.blob instanceof Blob ? record.blob : (record.id ? await (desktop ? repository.getImage(record.id, controller.signal) : readWebBackupImage(record.id)) : null)
          // Storage reads may not be abortable. Never download their late result after cancellation.
          check()
          if (!blob) failed++
          else {
            // A download URL retains its bytes until the browser grace period
            // expires. Apply backpressure instead of revoking a live download.
            while (imageDownloadUrls.size && (downloadBytes + blob.size > 64 * 1024 * 1024 || imageDownloadUrls.size >= 8)) {
              check()
              await pause(250)
            }
            check()
            const url = URL.createObjectURL(blob)
            let anchor: HTMLAnchorElement | undefined
            let started = false
            try {
              anchor = document.createElement('a')
              anchor.href = url
              anchor.download = buildArtworkFileName({
                title: record.name, timestamp: record.created_at, id: record.id,
                ext: blob.type === 'image/svg+xml' ? 'svg' : (blob.type || 'image/png').split('/')[1] || 'png',
              })
              document.body.appendChild(anchor)
              anchor.click()
              started = true
              saved++
            } finally {
              try { anchor?.remove() } finally {
                // Failed setup releases immediately; successful downloads retain their existing grace period.
                if (started && !disposed) { downloadBytes += blob.size; imageDownloadUrls.set(url, { timer: window.setTimeout(() => releaseImageUrl(url), 60_000), bytes: blob.size }) }
                else URL.revokeObjectURL(url)
              }
            }
          }
        } catch { if (!controller.signal.aborted) failed++ }
        if (controller.signal.aborted) break
        imageExportProgress.value = { completed: ++completed, total }
        // Inline blobs and cached reads must yield to the Cancel button between downloads.
        if (completed < total) await pause(0)
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
          const message = e instanceof Error && e.message ? e.message : String(e ?? '').trim()
          onFlash('导出图片失败：' + (message || '请检查浏览器存储'))
        }
      }
    } finally {
      source.release()
      imageExportController = null
      imageExportProgress.value = null
      busy.value = false
    }
  }

  return { imageExportProgress, exportImages, cancelExport, nativeImageExport }
}
