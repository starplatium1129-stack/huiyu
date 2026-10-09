/**
 * 本地图片导入作品册 — 纯逻辑核心（零依赖，可被 node 直接测试）。
 * IndexedDB 落盘在 desktopImport.ts 集成层。
 */

export const HISTORY_STORAGE_KEY = 'aics_pb_history'
export const MAX_IMPORT_BATCH = 8
export const MAX_IMPORT_BYTES = 24 * 1024 * 1024

export interface ImportResult {
  imported: number
  skipped: number
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

let importIdSeq = 0

function nextImportId(): string {
  importIdSeq += 1
  return `local-${Date.now().toString(36)}-${importIdSeq}`
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
    id: nextImportId(),
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

export interface ArtworkRecord {
  id: string | number
  timestamp?: string | number
  character?: string
  scene?: string | null
  sceneTitle?: string | null
  story?: string
  prompt?: string
  size?: string
  rating?: Record<string, unknown>
  lora?: string | null
  checkpoint?: string
  seed?: string | number
  sampler?: string
  favorite?: boolean
  version?: string | number
  width?: string | number | null
  height?: string | number | null
  image_id?: string
  image_url?: string
  image_data?: string
  project?: string
  [key: string]: unknown
}
