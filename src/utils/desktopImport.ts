/**
 * 本地图片通过当前作品仓储导入作品册；浏览器拖入/选择的 File 同样可用。
 *
 * 纯逻辑（过滤/记录构造）见 desktopImportCore.ts，可直接单元测试。
 */

import { artworkRepository } from '../storage/artworkRepository'
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
 * 失败的单张图片记入 skipped，不中断整批。
 */
export async function importLocalImages(files: readonly ImportSourceFile[]): Promise<ImportResult> {
  const repository = artworkRepository
  return repository.withStaging(async () => {
    const candidates = filterImageFiles(files)
    let imported = 0
    let skipped = 0
    for (const file of candidates) {
      let imageId: string | null = null
      let pendingRecord: ReturnType<typeof buildImportedRecord> | null = null
      const operationId = crypto.randomUUID()
      try {
        imageId = await repository.putImage(file.blob)
        const measured = await measureBlob(file.blob)
        const record = buildImportedRecord(file, imageId, measured)
        pendingRecord = record
        await repository.appendArtwork(record)
        void repository.cacheThumbnail(imageId, file.blob).catch(() => {})
        imported += 1
      } catch (error) {
        if (pendingRecord) {
          // A rejected append may already have committed. Never delete its image.
          try {
            const history = await repository.readHistory()
            if (Array.isArray(history) && history.some(item => item && typeof item === 'object'
              && String((item as { id?: unknown }).id) === String(pendingRecord!.id)
              && (item as { image_id?: unknown }).image_id === imageId)) {
              imported += 1
              continue
            }
          } catch { /* Unknown publication retains the staged image. */ }
          console.warn('[desktop-import] commit unknown; image retained', { operationId, imageId, error })
        } else if (imageId) {
          try { await repository.deleteImage(imageId) }
          catch (cleanupError) { console.warn('[desktop-import] image cleanup failed', { operationId, imageId, error, cleanupError }) }
        } else console.warn('[desktop-import] image write failed', { operationId, error })
        skipped += 1
      }
    }
    return { imported, skipped }
  })
}
