import type { MigrationEnvelope, MigrationRecord } from '../../types/migration';
import { entityKey } from './records';
import type { WorkspaceStorageContext } from './schema';
import { WorkspaceError, type WorkspaceBody, type EntityId } from './types';

const HISTORY = 'aics_pb_history', PROJECTS = 'aics_pb_projects', TRASH = 'aics_pb_trash';
export function readMigrationRecords(storage: WorkspaceStorageContext, id: string): MigrationRecord[] {
  return storage.db.prepare('SELECT body FROM migration_items WHERE migration_id=? ORDER BY item_id').all(id)
    .map(row => JSON.parse(String(row.body)) as MigrationRecord);
}
function collection(records: MigrationRecord[], key: string): unknown[] {
  const entries = records.filter(record => record.source === 'kv' && record.key === key).sort((a, b) => (a.index ?? -1) - (b.index ?? -1));
  if (entries.length) return entries.flatMap(record => record.index === undefined && Array.isArray(record.value) ? record.value : [record.value]);
  const legacy = records.find(record => record.source === 'local' && record.key === key);
  if (!legacy) return [];
  const parsed: unknown = typeof legacy.value === 'string' ? JSON.parse(legacy.value) : legacy.value;
  if (!Array.isArray(parsed)) throw new WorkspaceError('MIGRATION_FORMAT', 'Legacy artwork collection is not an array');
  return parsed;
}
function body(value: unknown): WorkspaceBody {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('id' in value)) throw new WorkspaceError('MIGRATION_FORMAT', 'Artwork/project record is invalid');
  entityKey(value.id as EntityId);
  return value as WorkspaceBody;
}
interface TrashEntry { id: string; deletedAt: number; historyEntries: unknown[]; projectRefs: Array<{ projectId: EntityId; hadReference: boolean }> }
export function validateMigrationRecords(storage: WorkspaceStorageContext, envelope: MigrationEnvelope): string[] {
  const blockers: string[] = [];
  const records = readMigrationRecords(storage, envelope.migrationId);
  const media = new Set(envelope.media.map(item => item.alias));
  try {
    const history = collection(records, HISTORY).map(body), projects = collection(records, PROJECTS).map(body);
    const trash = collection(records, TRASH) as TrashEntry[];
    const all = [...history];
    for (const entry of trash) {
      if (!entry || !Number.isFinite(entry.deletedAt) || !Array.isArray(entry.historyEntries) || !Array.isArray(entry.projectRefs)) throw new Error('trash');
      all.push(...entry.historyEntries.map(body));
    }
    const ids = all.map(item => entityKey(item.id));
    if (new Set(ids).size !== ids.length) blockers.push('artwork-id-collision');
    const projectIds = projects.map(item => entityKey(item.id));
    if (new Set(projectIds).size !== projectIds.length) blockers.push('project-id-collision');
    for (const item of all) {
      if (typeof item.image_id !== 'string' || !media.has(item.image_id)) blockers.push(`missing-original:${entityKey(item.id)}`);
    }
    const visible = new Set(history.map(item => entityKey(item.id)));
    for (const project of projects) {
      if (!Array.isArray(project.history_ids)) throw new Error('project');
      const refs = project.history_ids.map(id => entityKey(id as EntityId));
      if (new Set(refs).size !== refs.length || refs.some(id => !visible.has(id))) blockers.push(`project-reference:${entityKey(project.id)}`);
    }
    const checkRefs = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) { value.forEach(checkRefs); return; }
      for (const [key, entry] of Object.entries(value)) {
        if (/^(image_id|imageId|firstFrameImageId|lastFrameImageId|sourceImageId)$/.test(key)
          && typeof entry === 'string' && entry && !media.has(entry)) blockers.push(`missing-reference:${entry}`);
        else checkRefs(entry);
      }
    };
    for (const record of records) {
      let value = record.value;
      if (typeof value === 'string') { try { value = JSON.parse(value) as unknown; } catch { /* Scalar settings are expected. */ } }
      checkRefs(value);
    }
  } catch { blockers.push('unreadable-domain-record'); }
  return [...new Set(blockers)];
}

/** Called once, in the verification transaction of an empty candidate. Raw source
 * records stay in migration_items so quarantine and unknown compatibility fields
 * remain available even when a current view has no representation for them. */
export function publishMigrationRecords(storage: WorkspaceStorageContext, envelope: MigrationEnvelope, revision: number): void {
  const records = readMigrationRecords(storage, envelope.migrationId);
  const history = collection(records, HISTORY).map(body), projects = collection(records, PROJECTS).map(body);
  const trash = collection(records, TRASH) as TrashEntry[];
  const insertArtwork = (item: WorkspaceBody, deletedAt: number | null) => {
    const key = entityKey(item.id);
    storage.db.prepare('INSERT INTO artworks VALUES(?,?,?,?,?)').run(key, JSON.stringify(item.id), JSON.stringify(item), revision, deletedAt);
    const hash = storage.db.prepare('SELECT hash FROM media_aliases WHERE alias=?').get(String(item.image_id))!.hash;
    storage.db.prepare('INSERT OR IGNORE INTO media_refs VALUES(?,?,?)').run(deletedAt === null ? 'artwork' : 'trash', key, hash!);
  };
  history.forEach(item => insertArtwork(item, null));
  for (const project of projects) {
    const key = entityKey(project.id);
    storage.db.prepare('INSERT INTO projects VALUES(?,?,?,?)').run(key, JSON.stringify(project.id), JSON.stringify(project), revision);
    (project.history_ids as EntityId[]).forEach((id, position) => storage.db.prepare('INSERT INTO project_artworks VALUES(?,?,?)').run(key, entityKey(id), position));
  }
  for (const entry of trash) {
    for (const raw of entry.historyEntries) {
      const item = body(raw); insertArtwork(item, entry.deletedAt);
      const refs = entry.projectRefs.filter(ref => ref.hadReference && projects.some(project => entityKey(project.id) === entityKey(ref.projectId)))
        .map(ref => ({ project_key: entityKey(ref.projectId), position: (projects.find(project => entityKey(project.id) === entityKey(ref.projectId))!.history_ids as EntityId[]).length }));
      storage.db.prepare('INSERT INTO trash VALUES(?,?,?,?)').run(entityKey(item.id), entry.deletedAt, JSON.stringify(item), JSON.stringify(refs));
    }
  }
  for (const record of records) {
    if (!['settings', 'chat', 'draft'].includes(record.domain)) continue;
    // KV archive supersedes its legacy local copy, including the empty tombstone.
    if (record.source === 'local' && record.key === 'aics_chat_archive_v1' && records.some(row => row.key === 'chat_archive_v1' && row.source === 'kv')) continue;
    const key = record.source === 'session' ? `${record.windowId}:${record.key}` : record.key === 'chat_archive_v1' ? 'aics_chat_archive_v1' : record.key;
    storage.db.prepare('INSERT INTO profile_records VALUES(?,?,?,?)').run(record.domain, key, JSON.stringify(record.value), revision);
  }
}
