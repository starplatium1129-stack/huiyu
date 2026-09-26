import fs from 'node:fs';
import { digest, checkAvailableSpace, publishMedia, uploadedBytes, uploadMediaChunk, mediaPath, stagingPath, verifyMedia } from './media';
import { fingerprint } from './records';
import { nextRevision, type WorkspaceStorageContext } from './schema';
import { WorkspaceError, type ExecuteOptions, type WorkspaceContext } from './types';
import { publishMigrationRecords, validateMigrationRecords } from './migration-records';
import type { MigrationCommand, MigrationResult } from './migration-types';
import type { MigrationEnvelope, MigrationStatus } from '../../types/migration';
import { profileDomainForKey } from './profile-fields';

interface Session { principal_id: string; envelope: string; state: MigrationStatus['state']; report: string; revision: number }
function readSession(storage: WorkspaceStorageContext, id: string, principal: string): Session {
  const row = storage.db.prepare('SELECT * FROM migration_sessions WHERE migration_id=? AND principal_id=?').get(id, principal);
  if (!row) throw new WorkspaceError('NOT_FOUND', 'Migration session does not exist', 404);
  return row as unknown as Session;
}
function status(storage: WorkspaceStorageContext, id: string, principal: string): MigrationStatus {
  const row = readSession(storage, id, principal), envelope = JSON.parse(row.envelope) as MigrationEnvelope;
  return { migrationId: id, workspaceId: storage.workspaceId, fingerprint: envelope.fingerprint, source: envelope.source,
    state: row.state, revision: row.revision, totalRecords: envelope.records.length, totalMedia: envelope.media.length,
    importedRecords: Number(storage.db.prepare('SELECT COUNT(*) AS n FROM migration_items WHERE migration_id=?').get(id)!.n),
    importedMedia: Number(storage.db.prepare('SELECT COUNT(*) AS n FROM migration_media WHERE migration_id=? AND complete=1').get(id)!.n),
    blockers: JSON.parse(row.report) as string[], domains: ['artwork', 'settings', 'chat', 'draft'] };
}
function hasSecret(value: unknown): boolean {
  if (typeof value === 'string') { try { return hasSecret(JSON.parse(value)); } catch { return false; } }
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, item]) => (/^(api[-_]?key|authorization|password|secret|access[-_]?token|refresh[-_]?token|token)$/i.test(key)
    && item !== '' && item !== null && item !== undefined) || (typeof item === 'object' && hasSecret(item)));
}
function validateEnvelope(envelope: MigrationEnvelope): void {
  if (!envelope || envelope.format !== 'huiyu-migration' || envelope.version !== 1 || !envelope.source?.sourceProfileId
    || !envelope.source.origin || !Array.isArray(envelope.source.windowIds) || !Array.isArray(envelope.records)
    || !Array.isArray(envelope.media) || !Array.isArray(envelope.blockers) || !envelope.credentials?.verified) {
    throw new WorkspaceError('MIGRATION_FORMAT', 'Migration source identity or classification is incomplete');
  }
  const { fingerprint: expected, ...unsigned } = envelope;
  if (fingerprint(unsigned) !== expected) throw new WorkspaceError('MIGRATION_FORMAT', 'Migration manifest fingerprint does not match');
  if (envelope.blockers.length || envelope.records.some(record => ['credential', 'unknown', 'transient'].includes(record.domain))) {
    throw new WorkspaceError('MIGRATION_BLOCKED', 'Source contains unclassified records or credentials');
  }
  if (new Set(envelope.records.map(record => record.id)).size !== envelope.records.length
    || new Set(envelope.media.map(media => media.alias)).size !== envelope.media.length) throw new WorkspaceError('MIGRATION_FORMAT', 'Duplicate migration item identity');
  for (const record of envelope.records) {
    if (!['kv', 'local', 'session'].includes(record.source) || !record.key || !/^[a-f0-9]{64}$/.test(record.sha256)
      || (record.bytes !== undefined && (!Number.isSafeInteger(record.bytes) || record.bytes < 1))
      || (record.source === 'session' && (!record.windowId || !envelope.source.windowIds.includes(record.windowId)))
      || (['settings', 'chat', 'draft'].includes(record.domain) && profileDomainForKey(record.key === 'chat_archive_v1' ? 'aics_chat_archive_v1' : record.key) !== record.domain)) {
      throw new WorkspaceError('MIGRATION_FORMAT', 'Record classification does not match a supported source');
    }
  }
  for (const media of envelope.media) {
    if (!media.alias || !/^[a-f0-9]{64}$/.test(media.sha256) || !Number.isSafeInteger(media.bytes) || media.bytes < 1
      || !['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'video/mp4', 'video/webm'].includes(media.mime) || hasSecret(media.metadata)) {
      throw new WorkspaceError('MIGRATION_FORMAT', 'Invalid media manifest');
    }
  }
}
const operationKey = (id: string, alias: string) => digest(JSON.stringify(['migration', id, alias]));

export async function executeMigration(storage: WorkspaceStorageContext, command: MigrationCommand,
  context: WorkspaceContext, options: ExecuteOptions = {}): Promise<MigrationResult> {
  const principal = context.principalId;
  const checkCancelled = () => { if (options.isCancelled?.()) throw new WorkspaceError('CANCELLED', 'Migration request cancelled', 499); };
  checkCancelled();
  if (command.kind === 'migration.begin') {
    validateEnvelope(command.envelope);
    const envelope = command.envelope;
    storage.transaction(() => {
      const previous = storage.db.prepare('SELECT fingerprint,principal_id FROM migration_sessions WHERE migration_id=?').get(envelope.migrationId);
      if (previous) {
        if (previous.principal_id !== principal || previous.fingerprint !== envelope.fingerprint) throw new WorkspaceError('MIGRATION_CONFLICT', 'Source snapshot changed; create a new migration session');
        return;
      }
      if (storage.db.prepare('SELECT 1 FROM artworks UNION ALL SELECT 1 FROM projects UNION ALL SELECT 1 FROM migration_sessions LIMIT 1').get()) {
        throw new WorkspaceError('MIGRATION_CONFLICT', 'Import requires an independent empty candidate workspace');
      }
      checkAvailableSpace(storage.root, envelope.media.reduce((sum, media) => sum + media.bytes, 0) + envelope.records.reduce((sum, item) => sum + (item.bytes || 0), 0));
      storage.db.prepare('INSERT INTO migration_sessions VALUES(?,?,?,?,?,?,0)').run(envelope.migrationId, principal, envelope.fingerprint, JSON.stringify(envelope), 'importing', '[]');
      for (const media of envelope.media) {
        storage.db.prepare('INSERT INTO migration_media VALUES(?,?,?,?,?,0)').run(envelope.migrationId, media.alias, media.sha256, media.bytes, media.mime);
        storage.db.prepare('INSERT INTO leases VALUES(?,?,?,?,?)').run(operationKey(envelope.migrationId, media.alias), 'migration', media.sha256, null, Date.now());
      }
    });
    return status(storage, envelope.migrationId, principal);
  }
  const row = readSession(storage, command.migrationId, principal), envelope = JSON.parse(row.envelope) as MigrationEnvelope;
  if (command.kind === 'migration.status') return status(storage, command.migrationId, principal);
  if (command.kind === 'migration.activate') {
    if (row.state !== 'verified' && row.state !== 'activated') throw new WorkspaceError('MIGRATION_BLOCKED', 'Candidate is not verified');
    if (command.expectedFingerprint !== envelope.fingerprint) throw new WorkspaceError('MIGRATION_CONFLICT', 'Activation source fingerprint changed');
    storage.transaction(() => storage.db.prepare("UPDATE migration_sessions SET state='activated' WHERE migration_id=?").run(command.migrationId));
    return status(storage, command.migrationId, principal);
  }
  if (command.kind === 'migration.record') {
    const expected = envelope.records.find(item => item.id === command.itemId);
    if (!expected || expected.sha256 !== fingerprint(command.record) || hasSecret(command.record.value)) throw new WorkspaceError('MIGRATION_FORMAT', 'Record digest does not match the manifest or contains a credential');
    const { id: _id, sha256: _hash, bytes: _bytes, ...expectedFields } = expected;
    const { value: _value, ...actualFields } = command.record;
    if (fingerprint(expectedFields) !== fingerprint(actualFields)) throw new WorkspaceError('MIGRATION_FORMAT', 'Record does not match its classified manifest entry');
    const existing = storage.db.prepare('SELECT sha256 FROM migration_items WHERE migration_id=? AND item_id=?').get(command.migrationId, command.itemId);
    if (existing) return { itemId: command.itemId, imported: false };
    if (row.state !== 'importing') throw new WorkspaceError('MIGRATION_CONFLICT', 'Verified migration is immutable');
    storage.transaction(() => storage.db.prepare('INSERT INTO migration_items VALUES(?,?,?,?)').run(command.migrationId, command.itemId, expected.sha256, JSON.stringify(command.record)));
    return { itemId: command.itemId, imported: true };
  }
  if (command.kind === 'migration.recordChunk') {
    const expected = envelope.records.find(item => item.id === command.itemId);
    if (!expected?.bytes || row.state !== 'importing') throw new WorkspaceError('MIGRATION_FORMAT', 'Record chunk is outside an importing manifest');
    const key = operationKey(command.migrationId, `record:${command.itemId}`);
    const offset = uploadMediaChunk(storage.root, key, { alias: command.itemId, bytes: expected.bytes, sha256: expected.sha256, mime: 'application/json' }, command.offset, command.data);
    if (offset === expected.bytes) {
      const record = JSON.parse(fs.readFileSync(stagingPath(storage.root, key, command.itemId), 'utf8')) as import('../../types/migration').MigrationRecord;
      await executeMigration(storage, { kind: 'migration.record', operationId: command.operationId, migrationId: command.migrationId, itemId: command.itemId, record }, context, options);
    }
    return { itemId: command.itemId, offset };
  }
  if (command.kind === 'migration.media') {
    if (row.state !== 'importing') throw new WorkspaceError('MIGRATION_CONFLICT', 'Verified migration is immutable');
    const media = envelope.media.find(item => item.alias === command.alias);
    if (!media) throw new WorkspaceError('MIGRATION_FORMAT', 'Media is not in the manifest');
    const offset = uploadMediaChunk(storage.root, operationKey(command.migrationId, media.alias), media, command.offset, command.data);
    return { alias: media.alias, offset };
  }
  if (row.state !== 'importing') return status(storage, command.migrationId, principal);
  const blockers: string[] = [];
  if (status(storage, command.migrationId, principal).importedRecords !== envelope.records.length) blockers.push('incomplete-records');
  for (const media of envelope.media) {
    checkCancelled();
    try {
      const key = operationKey(command.migrationId, media.alias);
      if (uploadedBytes(storage.root, key, media.alias) !== media.bytes && !fs.existsSync(mediaPath(storage.root, media.sha256))) throw new Error('missing');
      publishMedia(storage.root, key, media, checkCancelled);
      verifyMedia(storage.root, mediaPath(storage.root, media.sha256), media, checkCancelled);
      storage.transaction(() => storage.db.prepare('UPDATE migration_media SET complete=1 WHERE migration_id=? AND alias=?').run(command.migrationId, media.alias));
    } catch (error) {
      if (error instanceof WorkspaceError && error.code === 'CANCELLED') throw error;
      blockers.push(`media:${media.alias}`);
    }
  }
  blockers.push(...validateMigrationRecords(storage, envelope));
  storage.transaction(() => {
    storage.db.prepare('UPDATE migration_sessions SET report=? WHERE migration_id=?').run(JSON.stringify(blockers), command.migrationId);
    if (blockers.length) return;
    const revision = nextRevision(storage);
    for (const media of envelope.media) {
      storage.db.prepare('INSERT OR IGNORE INTO media_objects VALUES(?,?,?)').run(media.sha256, media.bytes, media.mime);
      storage.db.prepare('INSERT INTO media_aliases VALUES(?,?)').run(media.alias, media.sha256);
      // All media, including temporary/quarantined originals, remain retained.
      storage.db.prepare('INSERT OR IGNORE INTO media_refs VALUES(?,?,?)').run('migration', command.migrationId, media.sha256);
    }
    publishMigrationRecords(storage, envelope, revision);
    storage.db.prepare("UPDATE migration_sessions SET state='verified',revision=? WHERE migration_id=?").run(revision, command.migrationId);
  });
  return status(storage, command.migrationId, principal);
}
