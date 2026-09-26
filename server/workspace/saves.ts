import fs from 'node:fs';
import { checkAvailableSpace, MAX_CHUNK_BYTES, mediaPath, publishMedia, stagingPath, uploadedBytes, uploadMediaChunk, verifyMedia } from './media';
import { artworkByKey, checkOperation, commitOperation, entityKey, findOperation, insertOperation, operationState, type OperationRow } from './records';
import { nextRevision, type WorkspaceStorageContext } from './schema';
import { WorkspaceError, type MutationReceipt, type OperationState, type WorkspaceCommand } from './types';

type SaveInput = Extract<WorkspaceCommand, { kind: 'prepareSave' }>;
function saveRow(context: WorkspaceStorageContext, principal: string, id: string): OperationRow {
  const row = findOperation(context, principal, id);
  if (!row) throw new WorkspaceError('NOT_FOUND', 'Save operation does not exist', 404);
  if (row.kind !== 'saveArtwork') throw new WorkspaceError('OPERATION_CONFLICT', 'Operation ID belongs to a different command');
  return row;
}
export function saveOperationState(context: WorkspaceStorageContext, row: OperationRow): OperationState {
  const state = operationState(row);
  if (row.kind !== 'saveArtwork') return state;
  const input = JSON.parse(row.input_json) as SaveInput;
  return { ...state, media: { ...input.media, writtenBytes: row.state === 'committed' ? input.media.bytes : uploadedBytes(context.root, row.op_key, input.media.alias) } };
}
export function prepareSave(context: WorkspaceStorageContext, principal: string, command: SaveInput): OperationState {
  const artworkKey = entityKey(command.artwork.id);
  if (!command.media || !/^[a-f0-9]{64}$/.test(command.media.sha256) || !Number.isSafeInteger(command.media.bytes)
    || command.media.bytes <= 0 || typeof command.media.alias !== 'string' || !command.media.alias.length
    || !['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'video/mp4', 'video/webm'].includes(command.media.mime)
    || (command.artwork.image_id !== undefined && command.artwork.image_id !== command.media.alias)) {
    throw new WorkspaceError('MEDIA_INVALID', 'Invalid save media metadata', 400);
  }
  const row = context.transaction(() => {
    const existing = findOperation(context, principal, command.operationId);
    if (existing) { checkOperation(existing, 'saveArtwork', command); return existing; }
    if (artworkByKey(context, artworkKey)) throw new WorkspaceError('OPERATION_CONFLICT', 'Artwork ID already exists');
    const alias = context.db.prepare('SELECT hash FROM media_aliases WHERE alias=?').get(command.media.alias);
    if (alias && alias.hash !== command.media.sha256) throw new WorkspaceError('OPERATION_CONFLICT', 'Media alias already identifies different bytes');
    checkAvailableSpace(context.root, command.media.bytes);
    const key = insertOperation(context, principal, command.operationId, 'saveArtwork', command);
    context.db.prepare('INSERT INTO leases VALUES(?,?,?,?,?)').run(key, 'staging', command.media.sha256, key, Date.now());
    return saveRow(context, principal, command.operationId);
  });
  context.checkpoint('prepared');
  return saveOperationState(context, row);
}
export function uploadSaveChunk(context: WorkspaceStorageContext, principal: string,
  command: Extract<WorkspaceCommand, { kind: 'uploadChunk' }>) {
  const row = saveRow(context, principal, command.operationId);
  const input = JSON.parse(row.input_json) as SaveInput;
  if (row.state === 'aborted') throw new WorkspaceError('OPERATION_CONFLICT', 'Save operation was aborted');
  if (row.state === 'committed') {
    if (!Number.isSafeInteger(command.offset) || command.offset < 0 || command.data.length < 1
      || command.data.length > MAX_CHUNK_BYTES || command.offset + command.data.length > input.media.bytes) {
      throw new WorkspaceError('MEDIA_INVALID', 'Invalid media chunk');
    }
    const fd = fs.openSync(mediaPath(context.root, input.media.sha256), 'r');
    try {
      const existing = Buffer.alloc(command.data.length);
      const count = fs.readSync(fd, existing, 0, existing.length, command.offset);
      if (count !== existing.length || !existing.equals(Buffer.from(command.data))) {
        throw new WorkspaceError('OPERATION_CONFLICT', 'Retried chunk differs from committed bytes');
      }
    } finally { fs.closeSync(fd); }
    return { operationId: command.operationId, offset: input.media.bytes };
  }
  return { operationId: command.operationId,
    offset: uploadMediaChunk(context.root, row.op_key, input.media, command.offset, command.data) };
}
export function commitSave(context: WorkspaceStorageContext, principal: string, id: string, checkCancelled: () => void): MutationReceipt {
  const row = saveRow(context, principal, id);
  if (row.state === 'committed') return JSON.parse(row.receipt_json!) as MutationReceipt;
  if (row.state === 'aborted') throw new WorkspaceError('OPERATION_CONFLICT', 'Save operation was aborted');
  const input = JSON.parse(row.input_json) as SaveInput;
  publishMedia(context.root, row.op_key, input.media, checkCancelled);
  context.checkpoint('media-published');
  checkCancelled();
  const receipt = context.transaction(() => {
    const key = entityKey(input.artwork.id);
    if (artworkByKey(context, key)) throw new WorkspaceError('OPERATION_CONFLICT', 'Artwork ID already exists');
    const previousAlias = context.db.prepare('SELECT hash FROM media_aliases WHERE alias=?').get(input.media.alias);
    if (previousAlias && previousAlias.hash !== input.media.sha256) throw new WorkspaceError('OPERATION_CONFLICT', 'Media alias conflicts with existing artwork');
    const revision = nextRevision(context);
    context.db.prepare('INSERT OR IGNORE INTO media_objects VALUES(?,?,?)').run(input.media.sha256, input.media.bytes, input.media.mime);
    context.db.prepare('INSERT OR IGNORE INTO media_aliases VALUES(?,?)').run(input.media.alias, input.media.sha256);
    context.db.prepare('INSERT INTO artworks VALUES(?,?,?,?,NULL)').run(key, JSON.stringify(input.artwork.id),
      JSON.stringify({ ...input.artwork, image_id: input.media.alias }), revision);
    context.db.prepare('INSERT INTO media_refs VALUES(?,?,?)').run('artwork', key, input.media.sha256);
    const result: MutationReceipt = { operationId: id, kind: 'saveArtwork', revision, artwork: artworkByKey(context, key)! };
    context.checkpoint('metadata-written');
    commitOperation(context, row.op_key, result);
    context.db.prepare('DELETE FROM leases WHERE operation_key=?').run(row.op_key);
    return result;
  });
  context.checkpoint('committed');
  // The committed receipt is authoritative. Leaving a staging hardlink after a crash
  // is harmless; never remove immutable media as compensation for a lost response.
  const staged = stagingPath(context.root, row.op_key, input.media.alias);
  try { if (fs.existsSync(staged)) fs.unlinkSync(staged); }
  catch { /* The committed receipt wins; GC can retry this owned staging hardlink later. */ }
  return receipt;
}
export function abortSave(context: WorkspaceStorageContext, principal: string, id: string): OperationState {
  const result = context.transaction(() => {
    const row = saveRow(context, principal, id);
    if (row.state === 'committed') return row;
    context.db.prepare("UPDATE operations SET state='aborted' WHERE op_key=?").run(row.op_key);
    context.db.prepare('DELETE FROM leases WHERE operation_key=?').run(row.op_key);
    return saveRow(context, principal, id);
  });
  return saveOperationState(context, result);
}
export function verifyArtworkMedia(context: WorkspaceStorageContext, idKey: string, checkCancelled: () => void): void {
  const refs = context.db.prepare('SELECT m.hash,m.bytes,m.mime FROM media_refs r JOIN media_objects m ON m.hash=r.hash WHERE r.owner_id=?').all(idKey);
  for (const media of refs) verifyMedia(context.root, mediaPath(context.root, String(media.hash)),
    { sha256: String(media.hash), bytes: Number(media.bytes), mime: String(media.mime) }, checkCancelled);
}
