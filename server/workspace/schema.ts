import fs from 'node:fs';
import { assertSafePath, syncDirectory } from './paths';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceError } from './types';

export type StorageCheckpoint = 'prepared' | 'media-published' | 'metadata-written' | 'committed';
export interface WorkspaceStorageContext {
  db: DatabaseSync;
  root: string;
  workspaceId: string;
  writerEpoch: string;
  transaction<T>(action: () => T): T;
  checkpoint(phase: StorageCheckpoint): void;
}

const schema = `
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
CREATE TABLE artworks(id_key TEXT PRIMARY KEY, id_json TEXT NOT NULL, body TEXT NOT NULL,
  revision INTEGER NOT NULL, deleted_at INTEGER);
CREATE TABLE projects(id_key TEXT PRIMARY KEY, id_json TEXT NOT NULL, body TEXT NOT NULL, revision INTEGER NOT NULL);
CREATE TABLE project_artworks(project_key TEXT NOT NULL REFERENCES projects(id_key) ON DELETE CASCADE,
  artwork_key TEXT NOT NULL REFERENCES artworks(id_key), position INTEGER NOT NULL,
  PRIMARY KEY(project_key,artwork_key), UNIQUE(project_key,position));
CREATE TABLE trash(artwork_key TEXT PRIMARY KEY REFERENCES artworks(id_key) ON DELETE CASCADE,
  deleted_at INTEGER NOT NULL, snapshot TEXT NOT NULL, project_refs TEXT NOT NULL);
CREATE TABLE media_objects(hash TEXT PRIMARY KEY, bytes INTEGER NOT NULL, mime TEXT NOT NULL);
CREATE TABLE media_aliases(alias TEXT PRIMARY KEY, hash TEXT NOT NULL REFERENCES media_objects(hash));
CREATE TABLE media_refs(owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL,
  hash TEXT NOT NULL REFERENCES media_objects(hash), PRIMARY KEY(owner_kind,owner_id,hash));
CREATE TABLE operations(op_key TEXT PRIMARY KEY, principal_id TEXT NOT NULL, kind TEXT NOT NULL,
  operation_id TEXT NOT NULL, fingerprint TEXT NOT NULL, state TEXT NOT NULL,
  input_json TEXT NOT NULL, receipt_json TEXT, revision INTEGER,
  UNIQUE(principal_id,kind,operation_id), UNIQUE(principal_id,operation_id));
CREATE TABLE leases(id TEXT PRIMARY KEY, kind TEXT NOT NULL, hash TEXT,
  operation_key TEXT REFERENCES operations(op_key), created_at INTEGER NOT NULL);
CREATE INDEX leases_hash ON leases(hash);
PRAGMA user_version=1;
`;

export function openStorage(options: { root: string; workspaceId: string; writerEpoch: string;
  create: boolean; onCheckpoint?: (phase: StorageCheckpoint) => void }): WorkspaceStorageContext {
  const root = assertSafePath(options.root);
  const identityFile = assertSafePath(root, 'workspace.json');
  const databaseFile = assertSafePath(root, 'huiyu.sqlite3');
  const hasIdentity = fs.existsSync(identityFile);
  const hasDatabase = fs.existsSync(databaseFile);
  if (hasIdentity !== hasDatabase || (!hasDatabase && !options.create)) {
    throw new WorkspaceError('WORKSPACE_IDENTITY', 'Workspace identity or database is missing; repair required');
  }
  if (hasIdentity) {
    const identity: unknown = JSON.parse(fs.readFileSync(identityFile, 'utf8'));
    if (!identity || typeof identity !== 'object' || !('workspaceId' in identity)
      || identity.workspaceId !== options.workspaceId || !('schemaVersion' in identity)
      || identity.schemaVersion !== 1 || !('databaseKind' in identity) || identity.databaseKind !== 'huiyu-workspace') {
      throw new WorkspaceError('WORKSPACE_IDENTITY', 'Workspace identity or format is unsupported');
    }
  } else {
    fs.mkdirSync(root, { recursive: true });
    const fd = fs.openSync(identityFile, 'wx');
    try {
      fs.writeFileSync(fd, JSON.stringify({ workspaceId: options.workspaceId, databaseKind: 'huiyu-workspace', schemaVersion: 1 }));
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    syncDirectory(root);
  }
  for (const suffix of ['', '-wal', '-shm']) assertSafePath(root, 'huiyu.sqlite3' + suffix);
  const db = new DatabaseSync(databaseFile);
  try {
    const version = db.prepare('PRAGMA user_version').get()?.user_version;
    if ((hasDatabase && version !== 1) || (!hasDatabase && version !== 0)) {
      throw new WorkspaceError('WORKSPACE_SCHEMA', 'Unsupported workspace schema; repair required');
    }
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
    db.exec('BEGIN IMMEDIATE');
    try {
      if (!hasDatabase) {
        db.exec(schema);
        const insert = db.prepare('INSERT INTO meta VALUES(?,?)');
        for (const [key, value] of Object.entries({ workspaceId: options.workspaceId,
          databaseKind: 'huiyu-workspace', schemaVersion: '1', revision: '0', writerEpoch: options.writerEpoch })) insert.run(key, value);
        db.prepare('INSERT INTO schema_migrations VALUES(1,?)').run(Date.now());
      } else {
        for (const [key, expected] of Object.entries({ workspaceId: options.workspaceId,
          databaseKind: 'huiyu-workspace', schemaVersion: '1' })) {
          if (db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value !== expected) {
            throw new WorkspaceError('WORKSPACE_IDENTITY', 'Workspace database identity mismatch');
          }
        }
        db.prepare("UPDATE meta SET value=? WHERE key='writerEpoch'").run(options.writerEpoch);
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return { db, root, workspaceId: options.workspaceId, writerEpoch: options.writerEpoch,
      checkpoint: options.onCheckpoint ?? (() => {}),
      transaction<T>(action: () => T): T {
        db.exec('BEGIN IMMEDIATE');
        try {
          if (db.prepare("SELECT value FROM meta WHERE key='writerEpoch'").get()?.value !== options.writerEpoch) {
            throw new WorkspaceError('WRITER_EPOCH', 'Workspace writer epoch is stale');
          }
          const result = action();
          db.exec('COMMIT');
          return result;
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      },
    };
  } catch (error) { db.close(); throw error; }
}

export function nextRevision(context: WorkspaceStorageContext): number {
  context.db.exec("UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'");
  return Number(context.db.prepare("SELECT value FROM meta WHERE key='revision'").get()?.value);
}
