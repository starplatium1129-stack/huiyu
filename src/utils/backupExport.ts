import type { StoredImageRecord } from '@/composables/useImageStore'
import { createBackup, normalizeBackup, summarizeBackup } from './backupCore'

/** One byte limit for both directions; never offer a file this version rejects. */
export const MAX_BACKUP_BYTES = 512 * 1024 * 1024
export const BACKUP_SIZE_MESSAGE = '备份文件超过 512 MB，暂不支持直接恢复；请先分批导出原图'
export interface BackupExportProgress { completed: number; total: number }

function checkSize(bytes: number, limit: number) {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > limit) throw new Error(BACKUP_SIZE_MESSAGE + '；本次未生成无法恢复的备份')
}
function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('已取消备份', 'AbortError')
}

export function readImageDataUrl(blob: Blob, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    checkAbort(signal)
    const reader = new FileReader()
    const cleanup = () => { signal?.removeEventListener('abort', abort); reader.onload = reader.onerror = reader.onabort = null }
    const abort = () => { reader.abort(); cleanup(); reject(new DOMException('已取消备份', 'AbortError')) }
    reader.onload = () => { const result = String(reader.result || ''); cleanup(); resolve(result) }
    reader.onerror = () => { const error = reader.error ?? new Error('读取图片失败'); cleanup(); reject(error) }
    reader.onabort = () => { cleanup(); reject(new DOMException('已取消备份', 'AbortError')) }
    signal?.addEventListener('abort', abort, { once: true })
    try { reader.readAsDataURL(blob) } catch (error) { cleanup(); reject(error) }
  })
}

/** Serialize one image at a time into Blob parts, not an all-images base64 array
 * plus one huge JSON string. Output stays schema v2 and is validated by the same
 * importer. This bounds the encoding working set, not total browser memory.
 */
export async function buildBackupBlob(
  payload: Omit<Parameters<typeof createBackup>[0], 'images'>,
  images: StoredImageRecord[],
  options: {
    signal?: AbortSignal
    onProgress?: (progress: BackupExportProgress) => void
    read?: typeof readImageDataUrl
    maxBytes?: number
  } = {},
) {
  const limit = options.maxBytes ?? MAX_BACKUP_BYTES
  checkSize(limit, MAX_BACKUP_BYTES)
  checkAbort(options.signal)
  const prefixes = images.map(record => {
    if (!(record.blob instanceof Blob) || !record.blob.size) throw new Error(`图片 ${record.id} 无法读取，未生成不完整备份`)
    return `data:${record.blob.type};base64,`
  })
  // Small placeholders let the existing importer check metadata/IDs/MIME before
  // any expensive file reading. Actual payloads are checked again below.
  const backup = createBackup({ ...payload, images: images.map((record, index) => ({
    id: record.id, name: record.name, type: record.type, size: record.blob.size,
    created_at: record.created_at, dataUrl: `${prefixes[index]}YQ==`,
  })) })
  const { images: metadata, ...header } = backup
  const prefix = `${JSON.stringify(header).slice(0, -1)},"images":[`
  const suffix = ']}'
  const parts: Blob[] = [new Blob([prefix])]
  let bytes = parts[0].size + new Blob([suffix]).size
  const estimated = metadata.reduce((sum, record, index) => sum
    + new Blob([JSON.stringify({ ...record, dataUrl: '' })]).size
    + prefixes[index].length + 4 * Math.ceil(images[index].blob.size / 3)
    + (index ? 1 : 0), bytes)
  checkSize(estimated, limit)
  options.onProgress?.({ completed: 0, total: images.length })
  for (let index = 0; index < images.length; index++) {
    checkAbort(options.signal)
    const dataUrl = await (options.read ?? readImageDataUrl)(images[index].blob, options.signal)
    checkAbort(options.signal)
    const record = normalizeBackup({ images: [{ ...metadata[index], dataUrl }] }).images[0]
    const part = new Blob([index ? ',' : '', JSON.stringify(record)])
    bytes += part.size
    checkSize(bytes, limit)
    parts.push(part)
    options.onProgress?.({ completed: index + 1, total: images.length })
  }
  checkAbort(options.signal)
  parts.push(new Blob([suffix]))
  const blob = new Blob(parts, { type: 'application/json;charset=utf-8' })
  checkSize(blob.size, limit)
  return { blob, summary: summarizeBackup(backup) }
}
