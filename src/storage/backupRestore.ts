import { imgPutRecord, imgDeleteMany } from '@/composables/useImageStore'
import { kvGet, kvSetMany } from '@/composables/useKVStore'
import { withArtworkMutation } from './artworkMutation'
import { mergeBackupRecords, type BackupFile, type BackupRecord } from '@/utils/backupCore'
import { prepareBackupSettings } from '@/utils/backupSettings'
import { CHAT_ARCHIVE_KV_KEY, readChatArchive, withChatArchiveMutation } from './chatArchiveRepository'
import { CHAT_ARCHIVE_KEY, emptyChatArchive, normalizeChatArchive, serializeChatArchive } from '@/utils/chatArchive'
import { listCompanionCharacterIds } from '@/utils/companionRegistry'
import { CHAT_ARCHIVE_CHANGED_KEY, CHAT_MEMORY_KEY, ARTWORK_HISTORY_KV_KEY, ARTWORK_PROJECTS_KV_KEY, collectLiveLocalSettings, isLiveLocalKey } from '@/utils/storageKeys'

const imageFields = new Set(['image_id', 'imageId', 'videoImageId', 'lastFrameImageId', 'imageIds'])
const mergeableSettings = new Set([CHAT_MEMORY_KEY, CHAT_ARCHIVE_KEY, 'aics_chat_v1'])
function remap(value: unknown, aliases: Map<string, string>, field = ''): unknown {
  if (typeof value === 'string') return imageFields.has(field) ? aliases.get(value) || value : value
  if (Array.isArray(value)) return value.map(item => remap(item, aliases, field))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remap(item, aliases, key)]))
  return value
}
function writeSettings(settings: Record<string, string>, replace: boolean) {
  if (replace) {
    const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)).filter((key): key is string => Boolean(key && isLiveLocalKey(key)))
    for (const key of keys) if (!(key in settings)) localStorage.removeItem(key)
  }
  for (const [key, value] of Object.entries(settings)) localStorage.setItem(key, value)
}

function rollbackSettings(previous: Record<string, string>, published: Record<string, string>, replace: boolean) {
  const keys = replace
    ? new Set([...Object.keys(previous), ...Object.keys(published)])
    : new Set(Object.keys(published))
  for (const key of keys) {
    const expected = key in published ? published[key] : null
    if (localStorage.getItem(key) !== expected) continue
    if (key in previous) localStorage.setItem(key, previous[key])
    else localStorage.removeItem(key)
  }
}

/** Stage new images under fresh IDs, then atomically publish history/projects. Never erase originals. */
export async function restoreBackupData(imported: BackupFile, replace: boolean): Promise<void> {
  return withArtworkMutation(() => replace || CHAT_ARCHIVE_KEY in imported.data.settings
    ? withChatArchiveMutation(() => restoreBackupDataNow(imported, replace))
    : restoreBackupDataNow(imported, replace))
}

async function restoreBackupDataNow(imported: BackupFile, replace: boolean): Promise<void> {
  const stagedIds: string[] = []
  const previousSettings = collectLiveLocalSettings(localStorage)
  const aliases = new Map<string, string>()
  // Decode every image before writing anything: malformed base64 must leave the current library intact.
  const images = imported.images.map(image => {
    const match = /^data:(image\/[^;,]+);base64,([\s\S]+)$/.exec(image.dataUrl)
    if (!match) throw new Error(`图片 ${image.id} 编码无效`)
    const bytes = Uint8Array.from(atob(match[2]), character => character.charCodeAt(0))
    if (!bytes.length) throw new Error(`图片 ${image.id} 为空`)
    if (aliases.has(image.id)) throw new Error(`备份含重复图片 ID：${image.id}`)
    const id = `img_restore_${crypto.randomUUID()}`
    aliases.set(image.id, id)
    return { id, blob: new Blob([bytes], { type: match[1] }), name: image.name, type: match[1], created_at: image.created_at }
  })
  const [history, projects] = await Promise.all([kvGet<BackupRecord[]>(ARTWORK_HISTORY_KV_KEY), kvGet<BackupRecord[]>(ARTWORK_PROJECTS_KV_KEY)])
  const importedHistory = (remap(imported.data.history, aliases) as BackupRecord[]).map(record =>
    !record.image_id && aliases.has(String(record.id)) ? { ...record, image_id: aliases.get(String(record.id)) } : record)
  const importedProjects = remap(imported.data.projects, aliases) as BackupRecord[]
  let settingsTouched = false
  let rollbackBaseline = previousSettings
  let publishedSettings: Record<string, string> = {}
  let pendingEntries: Array<{ key: string; value: unknown }> | null = null
  const archiveTouched = replace || CHAT_ARCHIVE_KEY in imported.data.settings
  const previousArchive = archiveTouched ? await kvGet(CHAT_ARCHIVE_KV_KEY) : null
  const operationId = crypto.randomUUID()
  try {
    for (const image of images) {
      stagedIds.push(image.id)
      await imgPutRecord(image)
    }
    const latestSettings = collectLiveLocalSettings(localStorage)
    // Compensation restores the values we actually replaced, including writes
    // made by another page during asynchronous image staging.
    rollbackBaseline = latestSettings
    const archiveSettings = archiveTouched ? { ...latestSettings, [CHAT_ARCHIVE_KEY]: serializeChatArchive(await readChatArchive()) } : latestSettings
    let nextSettings = prepareBackupSettings(archiveSettings, imported.data.settings, replace)
    if (!replace) {
      // A merge never overwrites a key changed by another writer while images were staged.
      // Chat history/memory/archive are explicitly merged against the latest value.
      nextSettings = Object.fromEntries(Object.entries(nextSettings).filter(([key]) =>
        mergeableSettings.has(key) || (latestSettings[key] ?? null) === (previousSettings[key] ?? null)))
    }
    for (const [key, value] of Object.entries(nextSettings)) {
      if (!(key in imported.data.settings) && !mergeableSettings.has(key)) continue
      try { nextSettings[key] = JSON.stringify(remap(JSON.parse(value), aliases)) } catch { /* 普通字符串设置 */ }
    }
    publishedSettings = { ...nextSettings }
    settingsTouched = true
    writeSettings(nextSettings, replace)
    pendingEntries = [
      { key: ARTWORK_HISTORY_KV_KEY, value: replace ? importedHistory : mergeBackupRecords(history || [], importedHistory) },
      { key: ARTWORK_PROJECTS_KV_KEY, value: replace ? importedProjects : mergeBackupRecords(projects || [], importedProjects) },
    ]
    if (archiveTouched) {
      const ids = listCompanionCharacterIds()
      const archive = nextSettings[CHAT_ARCHIVE_KEY]
        ? normalizeChatArchive(JSON.parse(nextSettings[CHAT_ARCHIVE_KEY]), ids) : emptyChatArchive(ids)
      if (replace) archive.revisions = Object.fromEntries(Object.keys(archive.archived).map(id => [id, crypto.randomUUID()]))
      pendingEntries.push({ key: CHAT_ARCHIVE_KV_KEY, value: archive })
    }
    await kvSetMany(pendingEntries)
    if (archiveTouched) try { localStorage.setItem(CHAT_ARCHIVE_CHANGED_KEY, crypto.randomUUID()) } catch { /* Invalidation is best effort. */ }
  } catch (error) {
    if (pendingEntries) {
      let unchanged = false
      try {
        const actual = await Promise.all(pendingEntries.map(entry => kvGet(entry.key)))
        if (actual.every((value, index) => JSON.stringify(value) === JSON.stringify(pendingEntries![index].value))) return
        unchanged = actual.every((value, index) => JSON.stringify(value) === JSON.stringify([history, projects, previousArchive][index]))
      } catch { /* Read failure cannot prove rollback. */ }
      if (!unchanged) {
        console.warn('[backup-restore] commit unknown; images retained', { operationId, imageIds: stagedIds, error })
        throw new Error(`恢复结果暂时无法确认；原有作品与原图未删除，导入图片已保留。请先核对作品册再重试（${operationId}）`)
      }
    }
    const cleanupErrors: string[] = []
    if (settingsTouched) {
      try { rollbackSettings(rollbackBaseline, publishedSettings, replace) } catch { cleanupErrors.push('设置回滚失败') }
    }
    try { await imgDeleteMany(stagedIds) } catch { cleanupErrors.push('临时图片清理失败') }
    if (cleanupErrors.length) console.warn('[backup-restore] cleanup failed', { operationId, imageIds: stagedIds, cleanupErrors, error })
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${message}；原有作品与原图未删除${cleanupErrors.length ? `；${cleanupErrors.join('、')}` : ''}`)
  }
}
