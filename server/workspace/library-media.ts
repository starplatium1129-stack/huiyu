import { checkAvailableSpace, mediaPath, publishMedia, uploadMediaChunk, uploadedBytes, verifyMedia } from './media';
import { artworkByKey, checkOperation, commitOperation, entityKey, findOperation, insertOperation, operationState } from './records';
import { nextRevision, type WorkspaceStorageContext } from './schema';
import { WorkspaceError, type MediaInput, type MutationReceipt, type OperationState, type WorkspaceBody } from './types';

export type LibraryMediaCommand =
  | { kind: 'prepareMedia'; operationId: string; media: MediaInput }
  | { kind: 'uploadMediaChunk'; operationId: string; offset: number; data: Uint8Array }
  | { kind: 'commitMedia'; operationId: string }
  | { kind: 'releaseMedia'; operationId: string; alias: string }
  | { kind: 'appendArtwork'; operationId: string; artwork: WorkspaceBody }
  | { kind: 'countMedia' };
export interface LibraryMediaResults {
  prepareMedia: OperationState;
  uploadMediaChunk: { operationId: string; offset: number };
  commitMedia: MutationReceipt;
  releaseMedia: MutationReceipt;
  appendArtwork: MutationReceipt;
  countMedia: number;
}
/** Original bytes may precede a saved artwork (drafts/imports). A durable temporary
 * reference protects them until the caller explicitly releases or attaches them. */
export function executeLibraryMedia(storage: WorkspaceStorageContext, principal: string, command: LibraryMediaCommand, cancelled: () => void): LibraryMediaResults[keyof LibraryMediaResults] {
  if (command.kind === 'countMedia') return Number(storage.db.prepare('SELECT count(*) AS count FROM media_aliases').get()!.count);
  if (command.kind === 'prepareMedia') {
    const media = command.media;
    if (!media || !media.alias || !/^[a-f0-9]{64}$/.test(media.sha256) || !Number.isSafeInteger(media.bytes) || media.bytes <= 0
      || !['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'video/mp4', 'video/webm'].includes(media.mime)) throw new WorkspaceError('MEDIA_INVALID', 'Invalid media', 400);
    const row = storage.transaction(() => {
      const old = findOperation(storage, principal, command.operationId);
      if (old) { checkOperation(old, command.kind, command); return old; }
      const alias = storage.db.prepare('SELECT hash FROM media_aliases WHERE alias=?').get(media.alias);
      if (alias && alias.hash !== media.sha256) throw new WorkspaceError('OPERATION_CONFLICT', 'Alias already exists');
      checkAvailableSpace(storage.root, media.bytes);
      const key = insertOperation(storage, principal, command.operationId, command.kind, command);
      storage.db.prepare('INSERT INTO leases VALUES(?,?,?,?,?)').run(key, 'staging', media.sha256, key, Date.now());
      return findOperation(storage, principal, command.operationId)!;
    });
    return { ...operationState(row), media: { ...media, writtenBytes: row.state === 'committed' ? media.bytes : uploadedBytes(storage.root, row.op_key, media.alias) } };
  }
  if (command.kind === 'uploadMediaChunk' || command.kind === 'commitMedia') {
    const row = findOperation(storage, principal, command.operationId);
    if (!row || row.kind !== 'prepareMedia' || row.state === 'aborted') throw new WorkspaceError('OPERATION_CONFLICT', 'Upload is not prepared');
    const { media } = JSON.parse(row.input_json) as { media: MediaInput };
    if (command.kind === 'uploadMediaChunk') {
      return { operationId: command.operationId, offset: row.state === 'committed' ? media.bytes : uploadMediaChunk(storage.root, row.op_key, media, command.offset, command.data) };
    }
    if (row.receipt_json) return JSON.parse(row.receipt_json) as MutationReceipt;
    publishMedia(storage.root, row.op_key, media, cancelled);
    cancelled();
    return storage.transaction(() => {
      const alias = storage.db.prepare('SELECT hash FROM media_aliases WHERE alias=?').get(media.alias);
      if (alias && alias.hash !== media.sha256) throw new WorkspaceError('OPERATION_CONFLICT', 'Media alias changed');
      storage.db.prepare('INSERT OR IGNORE INTO media_objects VALUES(?,?,?)').run(media.sha256, media.bytes, media.mime);
      storage.db.prepare('INSERT OR IGNORE INTO media_aliases VALUES(?,?)').run(media.alias, media.sha256);
      storage.db.prepare('INSERT OR IGNORE INTO media_refs VALUES(?,?,?)').run('temporary', media.alias, media.sha256);
      const result = { operationId: command.operationId, kind: 'commitMedia', revision: nextRevision(storage) };
      commitOperation(storage, row.op_key, result);
      storage.db.prepare('DELETE FROM leases WHERE operation_key=?').run(row.op_key);
      return result;
    });
  }
  if (command.kind === 'appendArtwork' && !findOperation(storage, principal, command.operationId)?.receipt_json) {
    const alias = command.artwork.image_id;
    const media = typeof alias === 'string' ? storage.db.prepare('SELECT m.hash,m.bytes,m.mime FROM media_aliases a JOIN media_objects m ON m.hash=a.hash WHERE a.alias=?').get(alias) : undefined;
    if (!media) throw new WorkspaceError('MEDIA_INVALID', 'Artwork media is unavailable');
    try { verifyMedia(storage.root, mediaPath(storage.root, String(media.hash)), { sha256: String(media.hash), bytes: Number(media.bytes), mime: String(media.mime) }, cancelled); }
    catch (error) { if (error instanceof WorkspaceError) throw error; throw new WorkspaceError('MEDIA_INVALID', 'Artwork original is missing or unreadable'); }
  }
  return storage.transaction(() => {
    const old = findOperation(storage, principal, command.operationId);
    if (old) { checkOperation(old, command.kind, command); if (old.receipt_json) return JSON.parse(old.receipt_json) as MutationReceipt; }
    const key = old?.op_key ?? insertOperation(storage, principal, command.operationId, command.kind, command);
    const revision = nextRevision(storage);
    const receipt: MutationReceipt = { operationId: command.operationId, kind: command.kind, revision };
    if (command.kind === 'releaseMedia') {
      storage.db.prepare("DELETE FROM media_refs WHERE owner_kind='temporary' AND owner_id=?").run(command.alias);
    } else {
      const artworkKey = entityKey(command.artwork.id);
      if (artworkByKey(storage, artworkKey)) throw new WorkspaceError('OPERATION_CONFLICT', 'Artwork already exists');
      const alias = command.artwork.image_id;
      if (typeof alias !== 'string') throw new WorkspaceError('MEDIA_INVALID', 'Artwork requires durable media');
      const media = storage.db.prepare('SELECT hash FROM media_aliases WHERE alias=?').get(alias);
      if (!media) throw new WorkspaceError('MEDIA_INVALID', 'Artwork media is unavailable');
      storage.db.prepare('INSERT INTO artworks VALUES(?,?,?,?,NULL)').run(artworkKey, JSON.stringify(command.artwork.id), JSON.stringify(command.artwork), revision);
      storage.db.prepare('INSERT INTO media_refs VALUES(?,?,?)').run('artwork', artworkKey, media.hash!);
      storage.db.prepare("DELETE FROM media_refs WHERE owner_kind='temporary' AND owner_id=?").run(alias);
      receipt.artwork = artworkByKey(storage, artworkKey)!;
    }
    commitOperation(storage, key, receipt);
    return receipt;
  });
}
