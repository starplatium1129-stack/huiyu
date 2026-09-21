export const BACKUP_APP = 'ai-cg-studio'
export const BACKUP_TYPE = 'aics-personal-backup'
export const BACKUP_SCHEMA_VERSION = 2

export type BackupRecord = Record<string, unknown> & {
  id?: unknown
  timestamp?: unknown
  updatedAt?: unknown
  createdAt?: unknown
  image_id?: unknown
}

export interface BackupImage {
  id: string
  name?: string
  type?: string
  size?: number
  created_at?: number
  dataUrl: string
}

export interface BackupFile {
  app: string
  appVersion: string
  schemaVersion: number
  createdAt: string
  data: {
    history: BackupRecord[]
    projects: BackupRecord[]
    settings: Record<string, string>
  }
  images: BackupImage[]
}

export interface BackupSummary {
  history: number
  projects: number
  images: number
  settings: number
  missingImages?: number
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function finite(value: unknown, fallback = 0): number {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function recordId(value: unknown): string | number | null {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return null
}

function stableLegacyId(record: BackupRecord, kind: 'history' | 'projects'): string {
  const serialized = JSON.stringify(record)
  let hash = 2166136261
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  const timestamp = finite(record.timestamp ?? record.updatedAt ?? record.createdAt)
  if (!timestamp) throw new Error(`备份 ${kind} 含缺少稳定 ID 的记录，已停止恢复`)
  return `legacy_${kind}_${timestamp}_${(hash >>> 0).toString(36)}`
}

function records(value: unknown, kind: 'history' | 'projects', allowLegacyIds: boolean): BackupRecord[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`备份 ${kind} 第 ${index + 1} 条记录不可展示，已停止恢复`)
    }
    const source = item as BackupRecord
    const existingId = recordId(source.id)
    const id = existingId ?? (allowLegacyIds ? stableLegacyId(source, kind) : null)
    if (id === null) throw new Error(`备份 ${kind} 第 ${index + 1} 条记录缺少有效 ID，已停止恢复`)
    const key = String(id)
    if (seen.has(key)) throw new Error(`备份 ${kind} 含重复记录 ID：${key}`)
    seen.add(key)
    return existingId === null ? { ...source, id } : source
  })
}

function settings(value: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(object(value))
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
}

function image(value: unknown): BackupImage | null {
  const source = object(value)
  const id = typeof source.id === 'string' ? source.id.trim() : ''
  const dataUrl = typeof source.dataUrl === 'string' ? source.dataUrl : ''
  if (!id || !/^data:image\/(?:png|jpeg|webp|gif|bmp|avif);base64,[a-z0-9+/=\s]+$/i.test(dataUrl)) return null
  return {
    id,
    name: typeof source.name === 'string' ? source.name : '',
    type: typeof source.type === 'string' ? source.type : '',
    size: Math.max(0, finite(source.size)),
    created_at: Math.max(0, finite(source.created_at)),
    dataUrl,
  }
}

export function normalizeBackup(raw: unknown): BackupFile {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('备份文件不是有效对象')
  const source = raw as Record<string, unknown>
  if (source.schemaVersion !== undefined && (typeof source.schemaVersion !== 'number' || !Number.isSafeInteger(source.schemaVersion) || source.schemaVersion < 0)) throw new Error('备份版本无效，请保留原件并确认格式')
  const version = source.schemaVersion === undefined ? 0 : source.schemaVersion as number
  if (version > BACKUP_SCHEMA_VERSION) throw new Error('该备份来自更新版本，请先升级网站')
  if (source.type != null && source.type !== BACKUP_TYPE) throw new Error('该文件不是绘遇备份')
  if (source.app != null && source.app !== BACKUP_APP) throw new Error('该文件不是绘遇备份')

  const hasLegacyData = ['history', 'projects', 'settings', 'images']
    .some(key => Object.prototype.hasOwnProperty.call(source, key))
  const hasNestedData = Object.prototype.hasOwnProperty.call(source, 'data')
    && Boolean(source.data && typeof source.data === 'object' && !Array.isArray(source.data))
  const nested = object(source.data)
  if (!hasNestedData && !hasLegacyData) throw new Error('该文件不包含可恢复的绘遇数据')

  const data = hasNestedData ? nested : source
  for (const key of ['history', 'projects']) {
    if (data[key] !== undefined && !Array.isArray(data[key])) {
      throw new Error(`备份 ${key} 数据损坏，已停止恢复`)
    }
  }
  if (source.images !== undefined && !Array.isArray(source.images)) throw new Error('备份图片列表格式无效')
  if (data.settings !== undefined && (!data.settings || typeof data.settings !== 'object' || Array.isArray(data.settings))) throw new Error('备份设置格式无效')
  const rawImages = Array.isArray(source.images) ? source.images : []
  const images = rawImages.map(image)
  if (images.some(item => !item)) throw new Error('备份含无效图片，没有可恢复的完整图片集；请重新导出备份')
  if (new Set(images.map(item => item!.id)).size !== images.length) throw new Error('备份包含重复图片 ID')
  const normalized: BackupFile = {
    app: String(source.app || BACKUP_APP),
    appVersion: String(source.appVersion || ''),
    schemaVersion: BACKUP_SCHEMA_VERSION,
    createdAt: String(source.createdAt || source.exportedAt || new Date(0).toISOString()),
    data: {
      history: records(data.history, 'history', version < 2),
      projects: records(data.projects, 'projects', version < 2),
      settings: settings(data.settings),
    },
    images: images as BackupImage[],
  }
  if (!normalized.data.history.length && !normalized.data.projects.length
      && !normalized.images.length && !Object.keys(normalized.data.settings).length) {
    throw new Error('备份文件里没有可恢复的数据')
  }
  return normalized
}

export function createBackup(payload: {
  appVersion: string
  history?: BackupRecord[]
  projects?: BackupRecord[]
  settings?: Record<string, string>
  images?: BackupImage[]
  createdAt?: string
}): BackupFile {
  return normalizeBackup({
    app: BACKUP_APP,
    type: BACKUP_TYPE,
    appVersion: payload.appVersion,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    createdAt: payload.createdAt || new Date().toISOString(),
    data: {
      history: payload.history || [],
      projects: payload.projects || [],
      settings: backupSafeSettings(payload.settings || {}),
    },
    images: payload.images || [],
  })
}

/** Recovery sources may still contain an un-migrated key; never export it. */
function backupSafeSettings(settings: Record<string, string>): Record<string, string> {
  const safe = { ...settings }
  if (safe.aics_chat_v1) {
    try {
      const chat = object(JSON.parse(safe.aics_chat_v1))
      delete chat.apiKey
      for (const field of ['settings', 'api']) {
        const record = object(chat[field])
        delete record.apiKey
        delete record.authorization
        delete record.headers
      }
      safe.aics_chat_v1 = JSON.stringify(chat)
    } catch { delete safe.aics_chat_v1 }
  }
  if (safe.aics_chat_api_drafts) {
    try {
      const drafts = object(JSON.parse(safe.aics_chat_api_drafts))
      safe.aics_chat_api_drafts = JSON.stringify(Object.fromEntries(Object.entries(drafts).map(([vendor, raw]) => {
        const entry = object(raw)
        return [vendor, { baseUrl: typeof entry.baseUrl === 'string' ? entry.baseUrl : '', model: typeof entry.model === 'string' ? entry.model : '' }]
      })))
    } catch { delete safe.aics_chat_api_drafts }
  }
  return safe
}

function recordTimestamp(record: BackupRecord): number {
  return finite(record.timestamp ?? record.updatedAt ?? record.createdAt)
}

export function mergeBackupRecords(current: BackupRecord[], incoming: BackupRecord[]): BackupRecord[] {
  const merged = new Map<string, BackupRecord>()
  const insert = (item: BackupRecord, index: number, source: 'current' | 'incoming') => {
    const timestamp = recordTimestamp(item)
    const key = item.id != null
      ? `id:${String(item.id)}`
      : timestamp ? `legacy:${timestamp}` : `${source}:${index}`
    const previous = merged.get(key)
    if (!previous || recordTimestamp(item) >= recordTimestamp(previous)) {
      merged.set(key, previous ? { ...previous, ...item } : { ...item })
    }
  }
  current.forEach((item, index) => insert(item, index, 'current'))
  incoming.forEach((item, index) => insert(item, index, 'incoming'))
  return [...merged.values()].sort((a, b) => recordTimestamp(b) - recordTimestamp(a))
}

export function summarizeBackup(backup: BackupFile): BackupSummary {
  const references = new Set<string>()
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(collect); return }
    if (!value || typeof value !== 'object') return
    for (const [key, child] of Object.entries(value)) {
      if (['image_id', 'imageId', 'videoImageId', 'lastFrameImageId'].includes(key) && typeof child === 'string' && child.trim()) {
        references.add(child.trim())
      } else if (key === 'imageIds' && Array.isArray(child)) {
        child.filter((id): id is string => typeof id === 'string' && Boolean(id.trim())).forEach(id => references.add(id.trim()))
      } else collect(child)
    }
  }
  collect([backup.data.history, backup.data.projects])
  const imageIds = new Set(backup.images.map(image => image.id))
  const missingImages = [...references].filter(id => !imageIds.has(id)).length
  return {
    history: backup.data.history.length,
    projects: backup.data.projects.length,
    images: backup.images.length,
    settings: Object.keys(backup.data.settings).length,
    ...(missingImages ? { missingImages } : {}),
  }
}
