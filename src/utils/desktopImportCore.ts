/**
 * 本地图片导入作品册：过滤与冻结记录，持久化由作品仓储拥有。
 */
import type { ArtworkRecord } from '../types/artwork.ts'

const MAX_IMPORT_BATCH = 8
const MAX_IMPORT_BYTES = 24 * 1024 * 1024

export interface ImportResult {
  imported: number
  skipped: number
  pending: string[]
}

export interface ImportSourceFile {
  name: string
  size: number
  type: string
  blob: Blob
}

function isImageFile(file: ImportSourceFile): boolean {
  return (/^image\/(?:png|jpeg|webp|gif|bmp|avif)$/i.test(file.type) || /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(file.name))
    && file.size > 0
    && file.size <= MAX_IMPORT_BYTES
}

export function filterImageFiles(files: readonly ImportSourceFile[]): ImportSourceFile[] {
  return files.filter(isImageFile).slice(0, MAX_IMPORT_BATCH)
}

/** 构造作品册记录（不落盘；测尺寸后由导入流程写入 KV）。 */
export function buildImportedRecord(
  file: ImportSourceFile,
  imageId: string,
  measured: { width: number | null; height: number | null },
): ArtworkRecord {
  const now = Date.now()
  const size = measured.width && measured.height ? `${measured.width}×${measured.height}` : '本地导入'
  return {
    id: `local-${crypto.randomUUID()}`,
    timestamp: now,
    prompt: `本地导入：${file.name.replace(/\.(png|jpe?g|webp|gif|bmp|avif|heic)$/i, '')}`,
    size,
    width: measured.width,
    height: measured.height,
    rating: {},
    favorite: false,
    image_id: imageId,
    image_url: '',
    version: 1,
  }
}
