import type { StatementResultingChanges } from 'node:sqlite';
import { digest } from './media';
import { nextRevision, type WorkspaceStorageContext } from './schema';
import { WorkspaceError, type EntityId, type MutationReceipt, type OperationState,
  type WorkspaceArtwork, type WorkspaceBody, type WorkspaceCommand, type WorkspaceProject } from './types';

export const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export function entityKey(id: EntityId): string {
  if ((typeof id !== 'string' || !id.trim().length) && (typeof id !== 'number' || !Number.isFinite(id))) {
    throw new WorkspaceError('INVALID_COMMAND', 'A stable string or finite numeric entity ID is required', 400);
  }
  return String(id).trim();
}
function canonical(value: unknown): unknown {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new WorkspaceError('INVALID_COMMAND', 'Workspace JSON numbers must be finite', 400);
  }
  if (Array.isArray(value)) return value.map(canonical);
  // Persisted operation fingerprints must not change with the host's locale.
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
  return value;
}
export const fingerprint = (value: unknown): string => digest(JSON.stringify(canonical(value)));
export interface OperationRow {
  op_key: string; principal_id: string; kind: string; operation_id: string; fingerprint: string;
  state: 'prepared' | 'committed' | 'aborted'; input_json: string; receipt_json: string | null; revision: number | null;
}
export function findOperation(context: WorkspaceStorageContext, principal: string, id: string): OperationRow | undefined {
  return context.db.prepare('SELECT * FROM operations WHERE principal_id=? AND operation_id=?').get(principal, id) as unknown as OperationRow | undefined;
}
export function operationState(row: OperationRow): OperationState {
  return { operationId: row.operation_id, kind: row.kind, state: row.state, revision: row.revision,
    ...(row.receipt_json ? { receipt: JSON.parse(row.receipt_json) as MutationReceipt } : {}) };
}
export function insertOperation(context: WorkspaceStorageContext, principal: string, id: string, kind: string, input: unknown): string {
  const key = digest(JSON.stringify([principal, kind, id]));
  context.db.prepare('INSERT INTO operations(op_key,principal_id,kind,operation_id,fingerprint,state,input_json) VALUES(?,?,?,?,?,?,?)')
    .run(key, principal, kind, id, fingerprint(input), 'prepared', JSON.stringify(input));
  return key;
}
export function checkOperation(row: OperationRow, kind: string, input: unknown): void {
  if (row.kind !== kind || row.fingerprint !== fingerprint(input)) throw new WorkspaceError('OPERATION_CONFLICT', 'Operation ID was already used with different input');
  if (row.state === 'aborted') throw new WorkspaceError('OPERATION_CONFLICT', 'Operation was explicitly aborted');
}
export function commitOperation(context: WorkspaceStorageContext, key: string, receipt: MutationReceipt): StatementResultingChanges {
  return context.db.prepare("UPDATE operations SET state='committed',receipt_json=?,revision=? WHERE op_key=?")
    .run(JSON.stringify(receipt), receipt.revision, key);
}
export function artworkByKey(context: WorkspaceStorageContext, key: string): WorkspaceArtwork | null {
  const row = context.db.prepare('SELECT id_json,body,revision,deleted_at FROM artworks WHERE id_key=?').get(key);
  if (!row) return null;
  return { id: JSON.parse(String(row.id_json)) as EntityId, body: JSON.parse(String(row.body)) as WorkspaceBody,
    revision: Number(row.revision), deletedAt: row.deleted_at === null ? null : Number(row.deleted_at) };
}
export function projectByKey(context: WorkspaceStorageContext, key: string): WorkspaceProject | null {
  const row = context.db.prepare('SELECT id_json,body,revision FROM projects WHERE id_key=?').get(key);
  return row ? { id: JSON.parse(String(row.id_json)) as EntityId, body: JSON.parse(String(row.body)) as WorkspaceBody, revision: Number(row.revision) } : null;
}
function requireArtwork(context: WorkspaceStorageContext, id: EntityId, expectedRevision: number): WorkspaceArtwork {
  const record = artworkByKey(context, entityKey(id));
  if (!record) throw new WorkspaceError('NOT_FOUND', 'Artwork does not exist', 404);
  if (record.revision !== expectedRevision) throw new WorkspaceError('REVISION_CONFLICT', 'Artwork has a newer revision');
  return record;
}
function updateMembership(context: WorkspaceStorageContext, projectKey: string, keys: string[], revision: number): void {
  const project = projectByKey(context, projectKey);
  if (!project) return;
  context.db.prepare('DELETE FROM project_artworks WHERE project_key=?').run(projectKey);
  const insert = context.db.prepare('INSERT INTO project_artworks VALUES(?,?,?)');
  const ids = keys.map((key, index) => {
    const artwork = artworkByKey(context, key);
    if (!artwork || artwork.deletedAt !== null) throw new WorkspaceError('NOT_FOUND', 'Project artwork does not exist', 404);
    insert.run(projectKey, key, index);
    return artwork.id;
  });
  context.db.prepare('UPDATE projects SET body=?,revision=? WHERE id_key=?')
    .run(JSON.stringify({ ...project.body, history_ids: ids }), revision, projectKey);
}
function membership(context: WorkspaceStorageContext, projectKey: string): string[] {
  return context.db.prepare('SELECT artwork_key FROM project_artworks WHERE project_key=? ORDER BY position').all(projectKey).map(row => String(row.artwork_key));
}

/** Bound the transaction and retain per-record conflicts; successful records commit together. */
export function softDeleteArtworks(context: WorkspaceStorageContext, principal: string,
  command: Extract<WorkspaceCommand, { kind: 'softDeleteArtworks' }>, checkCancelled: () => void): MutationReceipt {
  if (!Array.isArray(command.items) || !command.items.length || command.items.length > 200) {
    throw new WorkspaceError('INVALID_COMMAND', 'Delete batch must contain 1–200 artworks', 400);
  }
  const keys = command.items.map(item => {
    if (!item || !Number.isSafeInteger(item.expectedRevision) || item.expectedRevision < 0) {
      throw new WorkspaceError('INVALID_COMMAND', 'Expected artwork revision is required', 400);
    }
    return entityKey(item.id);
  });
  if (new Set(keys).size !== keys.length) throw new WorkspaceError('INVALID_COMMAND', 'Delete batch contains duplicate artworks', 400);
  const result = context.transaction(() => {
    const previous = findOperation(context, principal, command.operationId);
    if (previous) {
      checkOperation(previous, command.kind, command);
      if (previous.receipt_json) return JSON.parse(previous.receipt_json) as MutationReceipt;
    }
    const operationKey = previous?.op_key ?? insertOperation(context, principal, command.operationId, command.kind, command);
    const selected = new Map<string, WorkspaceArtwork>();
    const softDeleteResults = command.items.map((item, index) => {
      const artwork = artworkByKey(context, keys[index]);
      if (!artwork || artwork.deletedAt !== null) return { id: item.id, deleted: false, code: 'NOT_FOUND' as const };
      if (artwork.revision !== item.expectedRevision) return { id: item.id, deleted: false, code: 'REVISION_CONFLICT' as const };
      selected.set(keys[index], artwork);
      return { id: item.id, deleted: true };
    });
    const revision = nextRevision(context), deletedAt = Date.now();
    const affectedProjects = new Set<string>();
    const references = context.db.prepare(`SELECT artwork_key,project_key,position FROM project_artworks WHERE artwork_key IN (${keys.map(() => '?').join(',')})`).all(...keys);
    const refsByArtwork = new Map<string, Array<{ project_key: string; position: number }>>();
    for (const ref of references) {
      const key = String(ref.artwork_key);
      if (!selected.has(key)) continue;
      const refs = refsByArtwork.get(key) ?? [];
      refs.push({ project_key: String(ref.project_key), position: Number(ref.position) }); refsByArtwork.set(key, refs);
      affectedProjects.add(String(ref.project_key));
    }
    const trash = context.db.prepare('INSERT INTO trash VALUES(?,?,?,?)');
    const markDeleted = context.db.prepare('UPDATE artworks SET deleted_at=?,revision=? WHERE id_key=?');
    const protectMedia = context.db.prepare("UPDATE media_refs SET owner_kind='trash' WHERE owner_kind='artwork' AND owner_id=?");
    for (const [key, artwork] of selected) {
      checkCancelled();
      trash.run(key, deletedAt, JSON.stringify(artwork.body), JSON.stringify(refsByArtwork.get(key) ?? []));
      markDeleted.run(deletedAt, revision, key); protectMedia.run(key);
    }
    for (const projectKey of affectedProjects) {
      checkCancelled();
      updateMembership(context, projectKey, membership(context, projectKey).filter(key => !selected.has(key)), revision);
    }
    const receipt: MutationReceipt = { operationId: command.operationId, kind: command.kind, revision, softDeleteResults };
    context.checkpoint('metadata-written');
    commitOperation(context, operationKey, receipt);
    return receipt;
  });
  context.checkpoint('committed');
  return result;
}

type RecordMutation = Extract<WorkspaceCommand, { kind: 'patchArtwork' | 'softDeleteArtwork' | 'hardDeleteArtwork' | 'restoreArtwork' | 'saveProject' | 'purgeExpiredTrash' }>;
export function mutateRecord(context: WorkspaceStorageContext, principal: string, command: RecordMutation): MutationReceipt {
  const result = context.transaction(() => {
    const previous = findOperation(context, principal, command.operationId);
    if (previous) {
      checkOperation(previous, command.kind, command);
      if (previous.receipt_json) return JSON.parse(previous.receipt_json) as MutationReceipt;
    }
    const key = previous?.op_key ?? insertOperation(context, principal, command.operationId, command.kind, command);
    const revision = nextRevision(context);
    const receipt: MutationReceipt = { operationId: command.operationId, kind: command.kind, revision };
    if (command.kind === 'saveProject') {
      const projectKey = entityKey(command.project.id);
      const current = projectByKey(context, projectKey);
      if ((current?.revision ?? null) !== command.expectedRevision) throw new WorkspaceError('REVISION_CONFLICT', 'Project has a newer revision');
      const keys = command.artworkIds.map(entityKey);
      if (new Set(keys).size !== keys.length) throw new WorkspaceError('INVALID_COMMAND', 'Project contains duplicate artworks', 400);
      const project = { ...command.project, id: current?.id ?? command.project.id };
      context.db.prepare('INSERT INTO projects VALUES(?,?,?,?) ON CONFLICT(id_key) DO UPDATE SET body=excluded.body,revision=excluded.revision')
        .run(projectKey, JSON.stringify(project.id), JSON.stringify(project), revision);
      updateMembership(context, projectKey, keys, revision);
      receipt.project = projectByKey(context, projectKey)!;
    } else if (command.kind === 'purgeExpiredTrash') {
      const expired = context.db.prepare('SELECT artwork_key FROM trash WHERE deleted_at<=?').all(Date.now() - TRASH_RETENTION_MS);
      for (const row of expired) {
        const artworkKey = String(row.artwork_key);
        context.db.prepare("DELETE FROM media_refs WHERE owner_kind='trash' AND owner_id=?").run(artworkKey);
        context.db.prepare('DELETE FROM artworks WHERE id_key=?').run(artworkKey);
      }
      receipt.purged = expired.length;
    } else {
      const artworkKey = entityKey(command.id);
      const artwork = requireArtwork(context, command.id, command.expectedRevision);
      if (command.kind === 'hardDeleteArtwork') {
        const refs = storageMembershipProjects(context, artworkKey);
        for (const projectKey of refs) updateMembership(context, projectKey, membership(context, projectKey).filter(key => key !== artworkKey), revision);
        context.db.prepare("DELETE FROM media_refs WHERE owner_kind IN ('artwork','trash') AND owner_id=?").run(artworkKey);
        context.db.prepare('DELETE FROM artworks WHERE id_key=?').run(artworkKey);
        receipt.changed = true;
        receipt.removed = refs.length;
      } else if (command.kind === 'patchArtwork') {
        if ('id' in command.patch || 'image_id' in command.patch) throw new WorkspaceError('INVALID_COMMAND', 'Artwork identity and media cannot be patched', 400);
        if (artwork.deletedAt !== null) throw new WorkspaceError('OPERATION_CONFLICT', 'Restore the artwork before editing');
        context.db.prepare('UPDATE artworks SET body=?,revision=? WHERE id_key=?').run(JSON.stringify({ ...artwork.body, ...command.patch }), revision, artworkKey);
      } else if (command.kind === 'softDeleteArtwork' && artwork.deletedAt === null) {
        const deletedAt = Date.now();
        const refs = context.db.prepare('SELECT project_key,position FROM project_artworks WHERE artwork_key=?').all(artworkKey);
        context.db.prepare('INSERT INTO trash VALUES(?,?,?,?)').run(artworkKey, deletedAt, JSON.stringify(artwork.body), JSON.stringify(refs));
        context.db.prepare('UPDATE artworks SET deleted_at=?,revision=? WHERE id_key=?').run(deletedAt, revision, artworkKey);
        context.db.prepare("UPDATE media_refs SET owner_kind='trash' WHERE owner_kind='artwork' AND owner_id=?").run(artworkKey);
        for (const ref of refs) updateMembership(context, String(ref.project_key), membership(context, String(ref.project_key)).filter(item => item !== artworkKey), revision);
      } else if (command.kind === 'restoreArtwork' && artwork.deletedAt !== null) {
        const trash = context.db.prepare('SELECT snapshot,project_refs FROM trash WHERE artwork_key=?').get(artworkKey);
        if (!trash) throw new WorkspaceError('WORKSPACE_IDENTITY', 'Artwork trash snapshot is missing');
        context.db.prepare('UPDATE artworks SET body=?,deleted_at=NULL,revision=? WHERE id_key=?').run(String(trash.snapshot), revision, artworkKey);
        context.db.prepare("UPDATE media_refs SET owner_kind='artwork' WHERE owner_kind='trash' AND owner_id=?").run(artworkKey);
        const refs = JSON.parse(String(trash.project_refs)) as Array<{ project_key: string; position: number }>;
        for (const ref of refs) {
          if (!projectByKey(context, ref.project_key)) continue;
          const keys = membership(context, ref.project_key);
          if (!keys.includes(artworkKey)) keys.splice(Math.min(ref.position, keys.length), 0, artworkKey);
          updateMembership(context, ref.project_key, keys, revision);
        }
        context.db.prepare('DELETE FROM trash WHERE artwork_key=?').run(artworkKey);
      }
      const updated = artworkByKey(context, artworkKey);
      if (updated) { receipt.artwork = updated; receipt.changed = updated.revision === revision; }
    }
    context.checkpoint('metadata-written');
    commitOperation(context, key, receipt);
    return receipt;
  });
  context.checkpoint('committed');
  return result;
}
function storageMembershipProjects(context: WorkspaceStorageContext, artworkKey: string): string[] {
  return context.db.prepare('SELECT project_key FROM project_artworks WHERE artwork_key=?').all(artworkKey).map(row => String(row.project_key));
}
