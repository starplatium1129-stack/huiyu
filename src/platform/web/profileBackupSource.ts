import { kvGet } from '../../composables/useKVStore'
import { imgList, imgGet, imgDeleteMany } from '../../composables/useImageStore'
import { ARTWORK_HISTORY_KV_KEY, ARTWORK_PROJECTS_KV_KEY, ARTWORK_TRASH_KV_KEY, ARTWORK_HISTORY_QUARANTINE_KEY } from '../../utils/storageKeys'
import type { BackupRecord } from '../../utils/backupCore'

/** The portable Web backup intentionally has different scope from MigrationEnvelope. */
export async function readWebBackupLibrary() {
  const [history, projects] = await Promise.all([kvGet<BackupRecord[]>(ARTWORK_HISTORY_KV_KEY), kvGet<BackupRecord[]>(ARTWORK_PROJECTS_KV_KEY)])
  if ((history !== null && !Array.isArray(history)) || (projects !== null && !Array.isArray(projects))) throw new Error('作品记录格式异常，原件已保留。')
  return { history: history ?? [], projects: projects ?? [] }
}
export async function readWebBackupCleanup() {
  const [history, projects, trash, quarantine, images] = await Promise.all([
    kvGet(ARTWORK_HISTORY_KV_KEY), kvGet(ARTWORK_PROJECTS_KV_KEY), kvGet(ARTWORK_TRASH_KV_KEY), kvGet(ARTWORK_HISTORY_QUARANTINE_KEY), imgList(),
  ])
  return { history, projects, trash, quarantine, images }
}
export const readWebBackupImages = imgList
export const readWebBackupImage = imgGet
export const deleteWebBackupImages = imgDeleteMany
