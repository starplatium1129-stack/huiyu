import { imgPutRecord, imgDeleteMany } from '@/composables/useImageStore'
import { kvGet, kvSetMany } from '@/composables/useKVStore'
import { withArtworkMutation } from './artworkMutation'
import { mergeBackupRecords, type BackupFile, type BackupRecord } from '@/utils/backupCore'
import { prepareBackupSettings } from '@/utils/backupSettings'
import { CHAT_ARCHIVE_KEY } from '@/utils/chatArchive'
import { CHAT_MEMORY_KEY, ARTWORK_HISTORY_KV_KEY, ARTWORK_PROJECTS_KV_KEY, collectLiveLocalSettings, isLiveLocalKey } from '@/utils/storageKeys'

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
  return withArtworkMutation(() => restoreBackupDataNow(imported, replace))
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
  let publishedSettings: Record<string, string> = {}
  try {
    for (const image of images) {
      await imgPutRecord(image)
      stagedIds.push(image.id)
    }
    const latestSettings = collectLiveLocalSettings(localStorage)
    let nextSettings = prepareBackupSettings(latestSettings, imported.data.settings, replace)
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
    await kvSetMany([
      { key: ARTWORK_HISTORY_KV_KEY, value: replace ? importedHistory : mergeBackupRecords(history || [], importedHistory) },
      { key: ARTWORK_PROJECTS_KV_KEY, value: replace ? importedProjects : mergeBackupRecords(projects || [], importedProjects) },
    ])
  } catch (error) {
    const cleanupErrors: string[] = []
    if (settingsTouched) {
      try { rollbackSettings(previousSettings, publishedSettings, replace) } catch { cleanupErrors.push('设置回滚失败') }
    }
    try { await imgDeleteMany(stagedIds) } catch { cleanupErrors.push('临时图片清理失败') }
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${message}；原有作品与原图未删除${cleanupErrors.length ? `；${cleanupErrors.join('、')}` : ''}`)
  }
}
