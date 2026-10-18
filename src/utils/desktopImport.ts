/**
 * 本地图片通过当前作品仓储导入作品册；浏览器拖入/选择的 File 同样可用。
 *
 * 过滤与记录构造见 desktopImportCore.ts，存储写入沿原资料会话。
 */

import { artworkRepository } from '../storage/artworkRepository'
import { imageMediaSession } from '../platform/imageMediaSession'
import { onDesktopRuntime } from '../platform/desktop/runtime'
import { imageFormat, withImageMime } from './imageFormat'
import {
  buildImportedRecord,
  filterImageFiles,
  type ImportResult,
  type ImportSourceFile,
} from './desktopImportCore'

function measureBlob(blob: Blob): Promise<{ width: number | null; height: number | null }> {
  return new Promise(resolve => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      resolve({ width: img.naturalWidth || null, height: img.naturalHeight || null })
      URL.revokeObjectURL(url)
    }
    img.onerror = () => { resolve({ width: null, height: null }); URL.revokeObjectURL(url) }
    img.src = url
  })
}

/**
 * 导入本地图片到作品册。返回导入/跳过数量。
 * 普通文件失败记入 skipped；资料会话失效时停止其余项。
 */
export async function importLocalImages(files: readonly ImportSourceFile[]): Promise<ImportResult> {
  const repository = artworkRepository, session = imageMediaSession(), controller = new AbortController()
  function checkOwner() { if (repository !== artworkRepository || session !== imageMediaSession()) controller.abort() }
  const stopRuntime = onDesktopRuntime(checkOwner)
  function check() { checkOwner(); controller.signal.throwIfAborted() }
  try { return await repository.withStaging(async () => {
    check()
    const candidates = filterImageFiles(files)
    let imported = 0
    let skipped = files.length - candidates.length
    for (const [index, file] of candidates.entries()) {
      let imageId: string | null = null
      let pendingRecord: ReturnType<typeof buildImportedRecord> | null = null
      const operationId = crypto.randomUUID()
      try {
        check()
        const format = imageFormat(await file.blob.slice(0, 12).arrayBuffer())
        check()
        const blob = await withImageMime(file.blob, format.mime)
        check()
        imageId = await repository.putImage(blob)
        check()
        const measured = await measureBlob(blob)
        check()
        const record = buildImportedRecord(file, imageId, measured)
        pendingRecord = record
        await repository.appendArtwork(record)
        check()
        void repository.cacheThumbnail(imageId, blob).catch(() => {})
        imported += 1
      } catch (error) {
        if (pendingRecord) {
          // A rejected append may already have committed. Never delete its image.
          try {
            check()
            const saved = await repository.readArtwork(pendingRecord.id)
            check()
            if (saved && String(saved.id).trim() === String(pendingRecord.id).trim() && saved.image_id === imageId) {
              imported += 1
              continue
            }
          } catch { /* Unknown publication retains the staged image. */ }
          console.warn('[desktop-import] commit unknown; image retained', { operationId, imageId, error })
        } else if (imageId) {
          try { check(); await repository.deleteImage(imageId); check() }
          catch (cleanupError) { console.warn('[desktop-import] image cleanup failed', { operationId, imageId, error, cleanupError }) }
        } else console.warn('[desktop-import] image write failed', { operationId, error })
        if (controller.signal.aborted) { skipped += candidates.length - index; break }
        skipped += 1
      }
    }
    return { imported, skipped }
  }) } finally { stopRuntime() }
}
