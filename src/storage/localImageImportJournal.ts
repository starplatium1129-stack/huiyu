import { parseLocalImageImport, type LocalImageImport } from '../application/artwork/localImageImport.ts'
import { LOCAL_IMAGE_IMPORT_PENDING_PREFIX } from '../utils/storageKeys.ts'
import { assertMaintenanceWritable } from '../platform/maintenanceParticipants.ts'
import { assertMigrationWritable } from '../platform/web/migrationBarrier.ts'

type StorageReader = Pick<Storage, 'length' | 'key' | 'getItem'>
const keyFor = (entry: LocalImageImport) => LOCAL_IMAGE_IMPORT_PENDING_PREFIX + entry.input.operationId

/** Metadata only. Corrupt/unknown versions stay intact and block replacement. */
export function readLocalImageImportJournal(storage?: StorageReader) {
  const entries: LocalImageImport[] = [], errors: string[] = []
  try {
    storage ??= localStorage
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index)
      if (!key?.startsWith(LOCAL_IMAGE_IMPORT_PENDING_PREFIX)) continue
      try {
        const entry = parseLocalImageImport(JSON.parse(storage.getItem(key) ?? 'null'))
        if (key !== keyFor(entry)) throw new Error('图片导入恢复编号不一致，原记录已保留')
        entries.push(entry)
      } catch (error) { errors.push(error instanceof Error ? error.message : '图片导入恢复记录无法读取，原记录已保留') }
    }
  } catch { errors.push('图片导入恢复记录暂时无法读取，请恢复本地存储访问后重试') }
  return { entries, error: errors[0] ?? '' }
}
export function retainLocalImageImport(entry: LocalImageImport): void {
  assertMaintenanceWritable(); assertMigrationWritable()
  const encoded = JSON.stringify(parseLocalImageImport(entry)), key = keyFor(entry)
  const previous = localStorage.getItem(key)
  if (previous !== null && previous !== encoded) throw new Error('原图片导入记录已变化，已停止保存')
  if (previous === null) localStorage.setItem(key, encoded)
}
export function settleLocalImageImport(entry: LocalImageImport): void {
  assertMaintenanceWritable(); assertMigrationWritable()
  const key = keyFor(entry), previous = localStorage.getItem(key)
  if (previous === null) return
  if (previous !== JSON.stringify(entry)) throw new Error('原图片导入记录已变化，已保留恢复入口')
  localStorage.removeItem(key)
}
