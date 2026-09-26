import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { backup, DatabaseSync } from 'node:sqlite';
import { setImmediate } from 'node:timers/promises';
import { assertSafePath, syncDirectory } from './paths';
import type { WorkspaceStorageContext } from './schema';
import { entityKey } from './records';
import { detectedMime } from './media';
import { WorkspaceError, type ExecuteOptions } from './types';
import { supportedSchema, databaseSchema } from './schema-upgrade';

interface FileDigest { bytes: number; sha256: string }
interface BackupMedia { hash: string; bytes: number; mime: string }
interface BackupManifest {
  formatVersion: 1;
  kind: 'huiyu-workspace-backup';
  backupId: string;
  workspaceId: string;
  schemaVersion: number;
  revision: number;
  database: FileDigest;
  media: BackupMedia[];
}

function invalid(message: string): never { throw new WorkspaceError('BACKUP_INVALID', message); }
function checkCancelled(options: ExecuteOptions): void {
  if (options.isCancelled?.()) throw new WorkspaceError('CANCELLED', 'Workspace backup or candidate cancelled', 499);
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
async function hashFile(root: string, relative: string, options: ExecuteOptions = {}, mime?: string): Promise<FileDigest> {
  const file = assertSafePath(root, relative);
  if (!fs.statSync(file).isFile()) invalid('Backup entry is not a regular file');
  const fd = fs.openSync(file, 'r');
  const hash = createHash('sha256');
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  let bytes = 0;
  let header: Buffer | undefined;
  try {
    for (;;) {
      checkCancelled(options);
      const count = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!count) break;
      if (!header) header = Buffer.from(chunk.subarray(0, Math.min(count, 4096)));
      bytes += count;
      hash.update(chunk.subarray(0, count));
      await setImmediate();
    }
  } finally { fs.closeSync(fd); }
  if (mime && detectedMime(header ?? Buffer.alloc(0)) !== mime) invalid('Backup original media digest or actual file type mismatch');
  return { bytes, sha256: hash.digest('hex') };
}
function writeJson(root: string, relative: string, value: unknown): void {
  const file = assertSafePath(root, relative);
  const fd = fs.openSync(file, 'wx');
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  syncDirectory(path.dirname(file));
}
function publishMarker(root: string, relative: string, value: unknown): void {
  writeJson(root, relative + '.pending', value);
  const target = assertSafePath(root, relative);
  if (fs.existsSync(target)) invalid('Workspace completion marker already exists');
  fs.renameSync(assertSafePath(root, relative + '.pending'), target);
  syncDirectory(root);
}
async function copyVerified(source: string, target: string, relative: string, expected: FileDigest, options: ExecuteOptions): Promise<void> {
  const from = assertSafePath(source, relative);
  const to = assertSafePath(target, relative);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (!fs.statSync(from).isFile()) invalid('Backup source is not a regular file');
  const input = fs.openSync(from, 'r');
  try {
    const output = fs.openSync(to, 'wx');
    try {
      const chunk = Buffer.allocUnsafe(1024 * 1024);
      for (;;) {
        checkCancelled(options);
        const count = fs.readSync(input, chunk, 0, chunk.length, null);
        if (!count) break;
        let written = 0;
        while (written < count) written += fs.writeSync(output, chunk, written, count - written);
        await setImmediate();
      }
      fs.fsyncSync(output);
    } finally { fs.closeSync(output); }
  } finally { fs.closeSync(input); }
  const actual = await hashFile(target, relative, options);
  if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) invalid('Backup file hash or size mismatch');
  syncDirectory(path.dirname(to));
}
function objectPath(hash: string): string { return `media/objects/${hash.slice(0, 2)}/${hash}`; }
function mediaRows(db: DatabaseSync): BackupMedia[] {
  return db.prepare('SELECT hash,bytes,mime FROM media_objects ORDER BY hash').all().map(row => {
    if (typeof row.hash !== 'string' || !/^[a-f0-9]{64}$/.test(row.hash)
      || typeof row.bytes !== 'number' || !Number.isSafeInteger(row.bytes) || row.bytes < 0
      || typeof row.mime !== 'string') invalid('Backup media metadata is invalid');
    return { hash: row.hash, bytes: row.bytes, mime: row.mime };
  });
}
function ensureSpace(root: string, bytes: number): void {
  const space = fs.statfsSync(root);
  if (space.bavail * space.bsize < bytes + 1024 * 1024) {
    throw new WorkspaceError('BACKUP_SPACE', 'Insufficient free space for workspace backup or candidate');
  }
}
function validId(id: string): void {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) invalid('Invalid backup identity');
}
function parseManifest(root: string, backupId: string, workspaceId: string): BackupManifest {
  const value: unknown = JSON.parse(fs.readFileSync(assertSafePath(root, 'manifest.json'), 'utf8'));
  if (!record(value) || value.kind !== 'huiyu-workspace-backup' || value.formatVersion !== 1
    || !supportedSchema(value.schemaVersion) || value.backupId !== backupId || value.workspaceId !== workspaceId
    || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 || !record(value.database)
    || !Number.isSafeInteger(value.database.bytes) || Number(value.database.bytes) < 0
    || typeof value.database.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.database.sha256)
    || !Array.isArray(value.media)) invalid('Backup manifest format or identity is unsupported');
  const media: BackupMedia[] = value.media.map((item: unknown) => {
    if (!record(item) || typeof item.hash !== 'string' || !/^[a-f0-9]{64}$/.test(item.hash)
      || !Number.isSafeInteger(item.bytes) || Number(item.bytes) < 0 || typeof item.mime !== 'string') invalid('Invalid backup media manifest');
    return { hash: item.hash, bytes: Number(item.bytes), mime: item.mime };
  });
  if (new Set(media.map(item => item.hash)).size !== media.length) invalid('Duplicate backup media entry');
  return { formatVersion: 1, kind: 'huiyu-workspace-backup', backupId, workspaceId,
    schemaVersion: Number(value.schemaVersion), revision: Number(value.revision),
    database: { bytes: Number(value.database.bytes), sha256: value.database.sha256 }, media };
}
async function verifySnapshot(root: string, manifest: BackupManifest, options: ExecuteOptions): Promise<void> {
  const actual = await hashFile(root, 'huiyu.sqlite3', options);
  if (actual.bytes !== manifest.database.bytes || actual.sha256 !== manifest.database.sha256) invalid('Backup database hash mismatch');
  const identity: unknown = JSON.parse(fs.readFileSync(assertSafePath(root, 'workspace.json'), 'utf8'));
  if (!record(identity) || identity.workspaceId !== manifest.workspaceId || identity.schemaVersion !== manifest.schemaVersion
    || identity.databaseKind !== 'huiyu-workspace') invalid('Backup workspace identity mismatch');
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(assertSafePath(root, 'huiyu.sqlite3' + suffix))) invalid('Backup contains unexpected SQLite side files');
  }
  const db = new DatabaseSync(assertSafePath(root, 'huiyu.sqlite3'), { readOnly: true });
  try {
    if (db.prepare('PRAGMA user_version').get()?.user_version !== manifest.schemaVersion
      || db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok'
      || db.prepare('PRAGMA foreign_key_check').all().length) invalid('Backup database schema or integrity check failed');
    for (const [key, expected] of Object.entries({ workspaceId: manifest.workspaceId, databaseKind: 'huiyu-workspace',
      schemaVersion: String(manifest.schemaVersion), revision: String(manifest.revision) })) {
      if (db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value !== expected) invalid('Backup database identity or revision mismatch');
    }
    if (db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()?.version !== manifest.schemaVersion) invalid('Unknown backup migration version');
    if (JSON.stringify(mediaRows(db)) !== JSON.stringify([...manifest.media].sort((a, b) => a.hash.localeCompare(b.hash)))) invalid('Backup media inventory differs from database');
    for (const table of ['artworks', 'projects']) {
      for (const row of db.prepare(`SELECT id_key,id_json,body FROM ${table}`).all()) {
        checkCancelled(options);
        await setImmediate();
        const id: unknown = JSON.parse(String(row.id_json));
        const body: unknown = JSON.parse(String(row.body));
        if ((typeof id !== 'string' && typeof id !== 'number') || !record(body) || body.id !== id
          || row.id_key !== entityKey(id)) invalid('Invalid backup domain record');
        if (table === 'artworks') {
          const alias = db.prepare('SELECT hash FROM media_aliases WHERE alias=?').get(String(body.image_id));
          if (!alias || !db.prepare('SELECT 1 FROM media_refs WHERE owner_id=? AND hash=?').get(String(row.id_key), alias.hash)) {
            invalid('Backup artwork original reference is missing');
          }
        } else {
          const ids = db.prepare('SELECT a.id_json FROM project_artworks p JOIN artworks a ON a.id_key=p.artwork_key WHERE project_key=? ORDER BY position')
            .all(String(row.id_key)).map(item => JSON.parse(String(item.id_json)) as unknown);
          if (JSON.stringify(body.history_ids) !== JSON.stringify(ids)) invalid('Backup project order differs from its relationships');
        }
      }
    }
    for (const row of db.prepare('SELECT t.*,a.id_json,a.deleted_at AS artwork_deleted_at FROM trash t JOIN artworks a ON a.id_key=t.artwork_key').all()) {
      checkCancelled(options);
      await setImmediate();
      const snapshot: unknown = JSON.parse(String(row.snapshot));
      const references: unknown = JSON.parse(String(row.project_refs));
      if (!record(snapshot) || snapshot.id !== JSON.parse(String(row.id_json)) || row.deleted_at !== row.artwork_deleted_at
        || !Array.isArray(references) || references.some(item => !record(item) || typeof item.project_key !== 'string'
          || !Number.isSafeInteger(item.position) || Number(item.position) < 0)) invalid('Backup trash snapshot is invalid');
    }
  } finally { db.close(); }
  for (const media of manifest.media) {
    const actualMedia = await hashFile(root, objectPath(media.hash), options, media.mime);
    if (actualMedia.bytes !== media.bytes || actualMedia.sha256 !== media.hash) invalid('Backup original media digest mismatch');
  }
}

function prepareDirectory(context: WorkspaceStorageContext, relative: string, identity: string): string {
  const directory = assertSafePath(context.root, relative);
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  if (fs.existsSync(directory)) {
    const markerFile = assertSafePath(directory, 'incomplete.json');
    const marker: unknown = fs.existsSync(markerFile) ? JSON.parse(fs.readFileSync(markerFile, 'utf8')) : null;
    if ((!record(marker) || marker.identity !== identity || marker.workspaceId !== context.workspaceId)
      && fs.readdirSync(directory).length !== 0) {
      invalid('Incomplete backup directory ownership could not be verified');
    }
    // This exact child was generated by the recorded operation; it is never the active root.
    fs.rmSync(directory, { recursive: true });
  }
  fs.mkdirSync(directory);
  writeJson(directory, 'incomplete.json', { identity, workspaceId: context.workspaceId });
  return directory;
}

/** Only SQLite snapshot creation occupies the writer lane. Durable leases preserve
 * its originals while bounded, cancellable copies yield to later workspace writes. */
export async function backupWorkspace(context: WorkspaceStorageContext, backupId: string, options: ExecuteOptions = {}) {
  const schemaVersion = databaseSchema(context.db);
  validId(backupId);
  checkCancelled(options);
  context.transaction(() => {});
  const existing = assertSafePath(context.root, `backups/${backupId}`);
  if (fs.existsSync(assertSafePath(existing, 'manifest.json'))) {
    const manifest = parseManifest(existing, backupId, context.workspaceId);
    options.onCopyReady?.();
    await verifySnapshot(existing, manifest, options);
    context.transaction(() => context.db.prepare("DELETE FROM leases WHERE kind='backup' AND id LIKE ?").run(backupId + ':%'));
    return { backupId, revision: manifest.revision, mediaCount: manifest.media.length };
  }
  const destination = prepareDirectory(context, `backups/${backupId}`, backupId);
  const media = mediaRows(context.db);
  const databaseBytes = Number(context.db.prepare('PRAGMA page_count').get()?.page_count)
    * Number(context.db.prepare('PRAGMA page_size').get()?.page_size);
  ensureSpace(context.root, databaseBytes + media.reduce((sum, item) => sum + item.bytes, 0));
  const revision = context.transaction(() => {
    const insert = context.db.prepare('INSERT OR IGNORE INTO leases(id,kind,hash,operation_key,created_at) VALUES(?,?,?,NULL,?)');
    for (const item of media) insert.run(`${backupId}:${item.hash}`, 'backup', item.hash, Date.now());
    return Number(context.db.prepare("SELECT value FROM meta WHERE key='revision'").get()?.value);
  });
  // Never copy a live SQLite file: its committed records may still be in WAL.
  await backup(context.db, assertSafePath(destination, 'huiyu.sqlite3'));
  checkCancelled(options);
  const snapshot = new DatabaseSync(assertSafePath(destination, 'huiyu.sqlite3'));
  try {
    snapshot.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;');
    snapshot.prepare("DELETE FROM leases WHERE kind='backup' AND id LIKE ?").run(backupId + ':%');
  } finally { snapshot.close(); }
  const databaseFd = fs.openSync(assertSafePath(destination, 'huiyu.sqlite3'), 'r+');
  try { fs.fsyncSync(databaseFd); } finally { fs.closeSync(databaseFd); }
  options.onCopyReady?.();
  for (const item of media) await copyVerified(context.root, destination, objectPath(item.hash), { bytes: item.bytes, sha256: item.hash }, options);
  writeJson(destination, 'workspace.json', { workspaceId: context.workspaceId, databaseKind: 'huiyu-workspace', schemaVersion });
  const manifest: BackupManifest = { formatVersion: 1, kind: 'huiyu-workspace-backup', backupId,
    workspaceId: context.workspaceId, schemaVersion, revision,
    database: await hashFile(destination, 'huiyu.sqlite3', options), media };
  await verifySnapshot(destination, manifest, options);
  // Manifest is the completion marker; incomplete/failed backup directories are never restorable.
  publishMarker(destination, 'manifest.json', manifest);
  context.transaction(() => context.db.prepare("DELETE FROM leases WHERE kind='backup' AND id LIKE ?").run(backupId + ':%'));
  return { backupId, revision, mediaCount: media.length };
}

/** Restore creates a fresh, verified candidate only. Activation and generation changes
 * belong to the later maintenance/authority protocol, never to this operation. */
export async function restoreBackup(context: WorkspaceStorageContext, backupId: string, candidateId: string, options: ExecuteOptions = {}) {
  validId(backupId);
  validId(candidateId);
  checkCancelled(options);
  context.transaction(() => {});
  const source = assertSafePath(context.root, `backups/${backupId}`);
  const manifest = parseManifest(source, backupId, context.workspaceId);
  options.onCopyReady?.();
  await verifySnapshot(source, manifest, options);
  const existing = assertSafePath(context.root, `restore-candidates/${candidateId}`);
  if (fs.existsSync(assertSafePath(existing, 'candidate.json'))) {
    const marker: unknown = JSON.parse(fs.readFileSync(assertSafePath(existing, 'candidate.json'), 'utf8'));
    if (!record(marker) || marker.backupId !== backupId || marker.candidateId !== candidateId
      || marker.workspaceId !== context.workspaceId || marker.activated !== false || marker.state !== 'verified') invalid('Restore candidate identity mismatch');
    await verifySnapshot(existing, manifest, options);
    return { candidateId, revision: manifest.revision, mediaCount: manifest.media.length };
  }
  ensureSpace(context.root, manifest.database.bytes + manifest.media.reduce((sum, item) => sum + item.bytes, 0));
  const destination = prepareDirectory(context, `restore-candidates/${candidateId}`, `${backupId}:${candidateId}`);
  await copyVerified(source, destination, 'huiyu.sqlite3', manifest.database, options);
  for (const item of manifest.media) await copyVerified(source, destination, objectPath(item.hash), { bytes: item.bytes, sha256: item.hash }, options);
  writeJson(destination, 'workspace.json', { workspaceId: context.workspaceId, databaseKind: 'huiyu-workspace', schemaVersion: manifest.schemaVersion });
  await verifySnapshot(destination, manifest, options);
  publishMarker(destination, 'candidate.json', { formatVersion: 1, state: 'verified', backupId, candidateId,
    workspaceId: context.workspaceId, revision: manifest.revision, activated: false });
  return { candidateId, revision: manifest.revision, mediaCount: manifest.media.length };
}
