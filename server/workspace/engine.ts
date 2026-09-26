import fs from 'node:fs';
import { executeLibraryMedia } from './library-media';
import { executeTaskCommand } from './tasks';
import type { TaskCommand } from './task-types';
import { executeMigration } from './migration-commands';
import type { MigrationCommand } from './migration-types';
import { CURRENT_SCHEMA_VERSION } from './schema-upgrade';
import { executeProfile } from './profile-commands';
import type { ProfileCommand } from './profile-types';
import { backupWorkspace, restoreBackup } from './backup';
import { collectGarbage } from './garbage';
import { MAX_CHUNK_BYTES, mediaPath, verifyMedia } from './media';
import { artworkByKey, checkOperation, commitOperation, entityKey, findOperation, insertOperation, mutateRecord, projectByKey } from './records';
import { abortSave, commitSave, prepareSave, saveOperationState, uploadSaveChunk, verifyArtworkMedia } from './saves';
import { openStorage, type StorageCheckpoint } from './schema';
import { isWorkspaceMutation, WorkspaceError, type ExecuteOptions, type MutationReceipt,
  type WorkspaceCommand, type WorkspaceContext, type WorkspaceResult, type WorkspaceResults } from './types';

export function openWorkspaceEngine(options: { root: string; workspaceId: string; writerEpoch: string;
  create: boolean; onCheckpoint?: (phase: StorageCheckpoint) => void }) {
  const storage = openStorage(options);
  let closed = false;
  const verifiedMedia = new Map<string, string>();
  const revision = (): number => Number(storage.db.prepare("SELECT value FROM meta WHERE key='revision'").get()?.value);
  function currentWriter(): void {
    if (storage.db.prepare("SELECT value FROM meta WHERE key='writerEpoch'").get()?.value !== options.writerEpoch) {
      throw new WorkspaceError('WRITER_EPOCH', 'Workspace writer epoch is stale');
    }
  }
  async function backupCommand(command: Extract<WorkspaceCommand, { kind: 'backup' | 'restoreBackup' }>,
    principal: string, executeOptions: ExecuteOptions): Promise<WorkspaceResult> {
    const operation = storage.transaction(() => {
      const previous = findOperation(storage, principal, command.operationId);
      if (previous) { checkOperation(previous, command.kind, command); return previous; }
      insertOperation(storage, principal, command.operationId, command.kind, command);
      return findOperation(storage, principal, command.operationId)!;
    });
    if (operation.receipt_json) {
      const receipt = JSON.parse(operation.receipt_json) as MutationReceipt;
      return command.kind === 'backup'
        ? { backupId: receipt.backupId!, revision: receipt.revision, mediaCount: receipt.mediaCount! }
        : { candidateId: receipt.candidateId!, revision: receipt.revision, mediaCount: receipt.mediaCount! };
    }
    const hex = operation.op_key.slice(0, 32);
    const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    const result = command.kind === 'backup' ? await backupWorkspace(storage, id, executeOptions)
      : await restoreBackup(storage, command.backupId, id, executeOptions);
    storage.transaction(() => commitOperation(storage, operation.op_key,
      { operationId: command.operationId, kind: command.kind, ...result }));
    return result;
  }
  return {
    async execute(command: WorkspaceCommand, context: WorkspaceContext, executeOptions: ExecuteOptions = {}): Promise<WorkspaceResult> {
      if (closed) throw new WorkspaceError('STORAGE_UNAVAILABLE', 'Workspace storage is closed', 503);
      if (context.workspaceId !== options.workspaceId) throw new WorkspaceError('WORKSPACE_IDENTITY', 'Workspace identity mismatch');
      if (context.protocolVersion !== 1) throw new WorkspaceError('WORKSPACE_SCHEMA', 'Unsupported workspace protocol');
      if (typeof context.principalId !== 'string' || !context.principalId.length) throw new WorkspaceError('UNAUTHORIZED', 'Desktop principal is required', 401);
      if ('operationId' in command && (typeof command.operationId !== 'string' || !command.operationId.length || command.operationId.length > 200)) {
        throw new WorkspaceError('INVALID_COMMAND', 'A stable operation ID is required', 400);
      }
      const checkCancelled = () => {
        if (executeOptions.isCancelled?.()) throw new WorkspaceError('CANCELLED', 'Workspace request was cancelled', 499);
      };
      checkCancelled();
      if (isWorkspaceMutation(command)) currentWriter();
      if (command.kind.startsWith('task.')) return executeTaskCommand(storage, command as TaskCommand, context, executeOptions);
      if (command.kind.startsWith('migration.')) return executeMigration(storage, command as MigrationCommand, context, executeOptions);
      if (command.kind.startsWith('profile.')) return executeProfile(storage, command as ProfileCommand, context, executeOptions);
      const principal = context.principalId;
      switch (command.kind) {
        case 'prepareMedia': case 'uploadMediaChunk': case 'commitMedia': case 'releaseMedia': case 'appendArtwork': case 'countMedia':
          return executeLibraryMedia(storage, principal, command, checkCancelled);
        case 'status': return { workspaceId: options.workspaceId, databaseKind: 'huiyu-workspace', schemaVersion: CURRENT_SCHEMA_VERSION,
          writerEpoch: options.writerEpoch, revision: revision(), sqliteVersion: String(storage.db.prepare('SELECT sqlite_version() AS version').get()?.version) };
        case 'listArtworks': {
          const limit = command.limit ?? 100;
          if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new WorkspaceError('INVALID_COMMAND', 'List limit must be 1–200', 400);
          const rows = storage.db.prepare(`SELECT id_key FROM artworks WHERE id_key>? ${command.includeDeleted ? '' : 'AND deleted_at IS NULL'} ORDER BY id_key LIMIT ?`)
            .all(command.cursor ?? '', limit + 1);
          return { items: rows.slice(0, limit).map(row => artworkByKey(storage, String(row.id_key))!),
            nextCursor: rows.length > limit ? String(rows[limit - 1].id_key) : null, revision: revision() };
        }
        case 'getArtwork': return artworkByKey(storage, entityKey(command.id));
        case 'listProjects': return { items: storage.db.prepare('SELECT id_key FROM projects ORDER BY id_key').all().map(row => projectByKey(storage, String(row.id_key))!), revision: revision() };
        case 'prepareSave': return prepareSave(storage, principal, command);
        case 'uploadChunk': return uploadSaveChunk(storage, principal, command);
        case 'commitSave': return commitSave(storage, principal, command.operationId, checkCancelled);
        case 'abortSave': return abortSave(storage, principal, command.operationId);
        case 'getOperation': {
          const operation = findOperation(storage, principal, command.operationId);
          return operation ? saveOperationState(storage, operation) : null;
        }
        case 'restoreArtwork':
          if (!findOperation(storage, principal, command.operationId)?.receipt_json) verifyArtworkMedia(storage, entityKey(command.id), checkCancelled);
          return mutateRecord(storage, principal, command);
        case 'patchArtwork': case 'softDeleteArtwork': case 'hardDeleteArtwork': case 'saveProject': case 'purgeExpiredTrash':
          return mutateRecord(storage, principal, command);
        case 'collectGarbage': return collectGarbage(storage, principal, command, checkCancelled);
        case 'readMedia': {
          const media = storage.db.prepare('SELECT m.hash,m.bytes,m.mime FROM media_aliases a JOIN media_objects m ON m.hash=a.hash WHERE a.alias=?').get(command.alias);
          if (!media) throw new WorkspaceError('NOT_FOUND', 'Media does not exist', 404);
          const offset = command.offset ?? 0;
          const length = command.length ?? MAX_CHUNK_BYTES;
          if (!Number.isSafeInteger(offset) || offset < 0 || offset > Number(media.bytes) || !Number.isSafeInteger(length) || length < 1 || length > MAX_CHUNK_BYTES) {
            throw new WorkspaceError('INVALID_COMMAND', 'Invalid media read range', 400);
          }
          const file = mediaPath(storage.root, String(media.hash));
          const stat = fs.statSync(file, { bigint: true });
          const identity = `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
          // Range streaming uses many bounded reads of the same immutable object.
          // Hash once per observed file version, not once per 1 MiB of a video.
          if (verifiedMedia.get(file) !== identity) {
            verifyMedia(storage.root, file, { sha256: String(media.hash), bytes: Number(media.bytes), mime: String(media.mime) }, checkCancelled);
            if (verifiedMedia.size >= 256) verifiedMedia.delete(verifiedMedia.keys().next().value!);
            verifiedMedia.set(file, identity);
          }
          const data = Buffer.alloc(Math.min(length, Number(media.bytes) - offset));
          const fd = fs.openSync(file, 'r');
          try { fs.readSync(fd, data, 0, data.length, offset); } finally { fs.closeSync(fd); }
          return { data, mime: String(media.mime), totalBytes: Number(media.bytes), sha256: String(media.hash), offset } satisfies WorkspaceResults['readMedia'];
        }
        case 'backup': case 'restoreBackup': return backupCommand(command, principal, executeOptions);
        default: throw new WorkspaceError('INVALID_COMMAND', 'Unknown workspace command', 400);
      }
    },
    close(): void { if (!closed) { storage.db.close(); closed = true; } },
  };
}
