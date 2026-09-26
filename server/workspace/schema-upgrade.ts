import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { assertSafePath, syncDirectory } from './paths';
import { MIGRATION_SCHEMA_SQL } from './migration-schema';
import { TASK_SCHEMA_SQL } from './task-schema';
import { WorkspaceError } from './types';

export const CURRENT_SCHEMA_VERSION = 3;
const upgrades: Record<number, string> = { 2: MIGRATION_SCHEMA_SQL, 3: TASK_SCHEMA_SQL };
export function supportedSchema(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= CURRENT_SCHEMA_VERSION;
}
export function databaseSchema(db: DatabaseSync): number {
  const version = db.prepare('PRAGMA user_version').get()?.user_version;
  if (!supportedSchema(version)) throw new WorkspaceError('WORKSPACE_SCHEMA', 'Unsupported workspace schema; repair required');
  return version;
}
function atomicJson(root: string, name: string, value: unknown): void {
  const pending = assertSafePath(root, `${name}.${randomUUID()}.pending`);
  const fd = fs.openSync(pending, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(pending, assertSafePath(root, name));
  syncDirectory(root);
}
function upgradeDatabase(db: DatabaseSync, from: number, to: number): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    for (let version = from + 1; version <= to; version++) {
      if (!upgrades[version]) throw new WorkspaceError('WORKSPACE_SCHEMA', 'No supported schema migration');
      db.exec(upgrades[version]);
      db.prepare('INSERT INTO schema_migrations VALUES(?,?)').run(version, Date.now());
    }
    db.prepare("UPDATE meta SET value=? WHERE key='schemaVersion'").run(String(to));
    db.exec(`PRAGMA user_version=${to}`);
    db.exec('COMMIT');
  } catch (error) { try { db.exec('ROLLBACK'); } catch { /* A failed COMMIT is reconciled on reopen. */ } throw error; }
}

/** A durable intent reconciles the SQLite commit and the separate identity file. */
export function upgradeWorkspaceSchema(db: DatabaseSync, root: string, workspaceId: string): void {
  let identity = JSON.parse(fs.readFileSync(assertSafePath(root, 'workspace.json'), 'utf8')) as Record<string, unknown>;
  const intentFile = assertSafePath(root, 'schema-upgrade.json');
  let version = databaseSchema(db);
  const verify = () => {
    for (const [key, expected] of Object.entries({ workspaceId, databaseKind: 'huiyu-workspace', schemaVersion: String(version) })) {
      if (db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value !== expected) {
        throw new WorkspaceError('WORKSPACE_IDENTITY', 'Workspace database identity mismatch');
      }
    }
    if (db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()?.version !== version) {
      throw new WorkspaceError('WORKSPACE_SCHEMA', 'Workspace migration history is inconsistent');
    }
  };
  verify();
  if (fs.existsSync(intentFile)) {
    const intent = JSON.parse(fs.readFileSync(intentFile, 'utf8')) as Record<string, unknown>;
    if (intent.workspaceId !== workspaceId || !supportedSchema(intent.from) || !supportedSchema(intent.to)
      || intent.to <= intent.from || ![intent.from, intent.to].includes(version)
      || ![intent.from, intent.to].includes(Number(identity.schemaVersion))) {
      throw new WorkspaceError('WORKSPACE_SCHEMA', 'Unrecognized interrupted schema migration');
    }
    if (version === intent.from) upgradeDatabase(db, version, intent.to);
    version = databaseSchema(db); verify();
    identity = { ...identity, schemaVersion: version };
    atomicJson(root, 'workspace.json', identity);
    fs.unlinkSync(intentFile); syncDirectory(root);
  }
  if (identity.schemaVersion !== version) throw new WorkspaceError('WORKSPACE_IDENTITY', 'Workspace identity and database versions differ');
  if (version === CURRENT_SCHEMA_VERSION) return;
  atomicJson(root, 'schema-upgrade.json', { workspaceId, from: version, to: CURRENT_SCHEMA_VERSION });
  upgradeDatabase(db, version, CURRENT_SCHEMA_VERSION);
  version = databaseSchema(db); verify();
  atomicJson(root, 'workspace.json', { ...identity, schemaVersion: version });
  fs.unlinkSync(intentFile); syncDirectory(root);
}
