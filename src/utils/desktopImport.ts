import { withArtworkStaging } from '@/storage/artworkSession'
/**
 * 本地图片导入作品册（IndexedDB 集成层）。
 *
 * 桌宠/工作台在同一个 Electron session 内，IndexedDB（aics_image_store /
 * aics_kv_store）与网站共享；把本地图片写入图片库并追加一条作品册记录，
 * Atelier 作品册立即可见。浏览器里（无 Electron）同样可用：拖入/选择
 * 的 File 对象直接作为 Blob 入库。
 *
 * 纯逻辑（过滤/记录构造）见 desktopImportCore.ts，可直接单元测试。
 */

import { imgPut, imgDelete } from '../composables/useImageStore'
import { kvGet, kvSet } from '../composables/useKVStore'
import { ARTWORK_HISTORY_KV_KEY } from './storageKeys'
import { artworkRepository } from '../storage/artworkRepository'
import { blobThumbDataUrl, thumbKey } from './imageThumb'
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
  return withArtworkStaging(async () => {
    const candidates = filterImageFiles(files)
    let imported = 0
    let skipped = 0
    for (const file of candidates) {
      let imageId: string | null = null
      let pendingRecord: ReturnType<typeof buildImportedRecord> | null = null
      const operationId = crypto.randomUUID()
      try {
        imageId = await imgPut(file.blob)
        const measured = await measureBlob(file.blob)
        const record = buildImportedRecord(file, imageId, measured)
        pendingRecord = record
        await artworkRepository.appendArtwork(record)
        const thumbnailId = imageId
        void blobThumbDataUrl(file.blob).then(dataUrl => {
          if (dataUrl) return kvSet(thumbKey(thumbnailId), dataUrl).catch(() => {})
          return undefined
        }).catch(() => {})
        imported += 1
      } catch (error) {
        if (pendingRecord) {
          // A rejected append may already have committed. Never delete its image.
          try {
            const history = await kvGet<unknown[]>(ARTWORK_HISTORY_KV_KEY)
            if (Array.isArray(history) && history.some(item => item && typeof item === 'object'
              && String((item as { id?: unknown }).id) === String(pendingRecord!.id)
              && (item as { image_id?: unknown }).image_id === imageId)) {
              imported += 1
              continue
            }
          } catch { /* Unknown publication retains the staged image. */ }
          console.warn('[desktop-import] commit unknown; image retained', { operationId, imageId, error })
        } else if (imageId) {
          try { await imgDelete(imageId) }
          catch (cleanupError) { console.warn('[desktop-import] image cleanup failed', { operationId, imageId, error, cleanupError }) }
        } else console.warn('[desktop-import] image write failed', { operationId, error })
        skipped += 1
      }
    }
    return { imported, skipped }
  })
}
