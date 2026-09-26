import * as keys from '../../utils/storageKeys.ts'
import type { MigrationDomain, MigrationSource } from '../../../types/migration'

const artworks = new Set<string>([keys.ARTWORK_HISTORY_KV_KEY, keys.ARTWORK_PROJECTS_KV_KEY, keys.ARTWORK_TRASH_KV_KEY])
const sessions = new Set<string>([keys.VIDEO_CONTEXT_KEY, keys.VIDEO_SHOTS_CONTEXT_KEY, keys.VIDEO_SCENARIO_CONTEXT_KEY,
  keys.VIDEO_DRAFT_KEY, keys.VIDEO_SHOTS_DRAFT_KEY, keys.TEMP_RESULT_KEY])
const histories = new Set<string>([keys.TASK_CENTER_KV_KEY, keys.SD_QUEUE_SNAPSHOT_KEY, keys.VIDEO_TASK_KEY, keys.VIDEO_SHOTS_BATCH_KEY])
const transient = new Set<string>([keys.CHAT_ARCHIVE_CHANGED_KEY, keys.CHAT_TURN_KEY, keys.CHAT_RELAY_RECEIPT_KEY,
  keys.COMPANION_CHAT_LIVE_KEY, keys.ROOM_PRESENTATION_KEY, 'huiyu:migration:barrier'])
const chats = new Set<string>(['aics_chat_v1', keys.CHAT_ARCHIVE_KV_KEY, 'aics_chat_archive_v1', keys.CHAT_RESET_KEY,
  keys.CHAT_MEMORY_KEY, keys.CHAT_USER_PROFILE_KEY, keys.RETIRED_COMPANION_CHAT_KEY])

/** All physical keys are inventoried, including intentionally non-backup keys. */
export function classifyMigrationKey(source: MigrationSource, key: string): MigrationDomain {
  // wl-live2d 1.0.8 caches array indices under these two keys (dist/es/index.js).
  // browserBackend supplies one explicit model, so the indices are derivative;
  // preserve their bytes as legacy records instead of replaying model selection.
  if (source === 'local' && (key === 'model-id' || key === 'texture-id')) return 'quarantine'
  if (artworks.has(key)) return 'artwork'
  if (key === keys.ARTWORK_HISTORY_QUARANTINE_KEY || keys.isDeadLocalKey(key)) return 'quarantine'
  if (histories.has(key)) return 'history'
  if (transient.has(key)) return 'transient'
  if (chats.has(key)) return 'chat'
  if (sessions.has(key) || key.startsWith(keys.CHAT_DRAFT_PREFIX) || key.startsWith('aics-model-draft-') || key === 'aics_pb_last_draft') return 'draft'
  if (keys.isLiveLocalKey(key) || key === keys.BACKUP_AT_KEY) return 'settings'
  if (/credential|token|password|secret|api.?key/i.test(key)) return 'credential'
  // Session origin scope is not enough to declare an unregistered value disposable.
  return 'unknown'
}

export function parseMigrationValue(value: string): unknown {
  try { return JSON.parse(value) } catch { return value }
}

export function credentialFields(value: unknown, path = ''): string[] {
  if (!value || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([key, item]) => {
    const location = path ? `${path}.${key}` : key
    if (/^(api[-_]?key|authorization|password|secret|access[-_]?token|refresh[-_]?token|token)$/i.test(key)
      && item !== '' && item !== null && item !== undefined) return [location]
    return credentialFields(item, location)
  })
}
