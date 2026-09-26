import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openWorkspaceEngine } from '../../server/workspace/engine';
import { digest } from '../../server/workspace/media';
import { fingerprint } from '../../server/workspace/records';
import type { MigrationEnvelope, MigrationRecord } from '../../types/migration';
import type { WorkspaceCommand, WorkspaceContext, WorkspaceResults } from '../../server/workspace/types';

const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jM1sAAAAASUVORK5CYII=', 'base64');
const context: WorkspaceContext = { principalId: 'fixture-desktop', workspaceId: 'fixture-migration', protocolVersion: 1 };
const fixture: MigrationRecord[] = [
  { source: 'kv', key: 'aics_pb_history', domain: 'artwork', index: 0, value: { id: 42, image_id: 'visible', future: { raw: ['retained'] } } },
  { source: 'kv', key: 'aics_pb_projects', domain: 'artwork', index: 0, value: { id: 'project', history_ids: [42], future: true } },
  { source: 'kv', key: 'aics_pb_trash', domain: 'artwork', index: 0, value: { id: '43', deletedAt: 1780000000000, historyEntries: [{ id: '43', image_id: 'trash', future: 123 }], projectRefs: [{ projectId: 'project', hadReference: true }], imageIds: ['trash'] } },
  { source: 'kv', key: 'aics_pb_history_quarantine', domain: 'quarantine', index: 0, value: { original: { malformed: true }, extra: 'kept' } },
  { source: 'kv', key: 'chat_archive_v1', domain: 'chat', value: { version: 1, archived: { nene: [] }, revisions: { nene: 'reset' } } },
  { source: 'local', key: 'aics_chat_v1', domain: 'chat', value: '{"version":3,"histories":{},"settings":{"apiKey":"","future":true}}' },
  { source: 'local', key: 'aics_chat_reset_v1', domain: 'chat', value: 'reset-stamp' },
  { source: 'local', key: 'aics_theme', domain: 'settings', value: 'dark' },
  { source: 'session', key: 'aics_pb_temp_result_v1', windowId: 'main', domain: 'draft', value: '{"imageId":"temporary"}' },
  { source: 'kv', key: 'aics_task_center_v1', domain: 'history', value: [{ id: 'historical-task', status: 'running' }] },
];
function manifest(records = fixture, migrationId = 'migration-fixture'): MigrationEnvelope {
  const unsigned = {
    format: 'huiyu-migration' as const, version: 1 as const, migrationId,
    source: { sourceProfileId: 'original-profile', origin: 'http://127.0.0.1:3000', windowIds: ['main', 'chat'] },
    createdAt: 1780000000000,
    records: records.map((record, index) => { const { value: _value, ...fields } = record; return { ...fields, id: `record-${index}`, sha256: fingerprint(record) }; }),
    media: ['visible', 'trash', 'temporary'].map(alias => ({ alias, sha256: digest(bytes), bytes: bytes.length, mime: 'image/png', metadata: { name: alias, future: true }, derived: false })),
    blockers: [], credentials: { references: [], verified: true },
  };
  return { ...unsigned, fingerprint: fingerprint(unsigned) };
}
async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huiyu-migration-'));
  let engine = openWorkspaceEngine({ root, workspaceId: context.workspaceId, writerEpoch: 'fixture', create: true });
  const call = <K extends WorkspaceCommand['kind']>(command: Extract<WorkspaceCommand, { kind: K }>) => engine.execute(command, context) as Promise<WorkspaceResults[K]>;
  try {
    const envelope = manifest();
    await call({ kind: 'migration.begin', operationId: 'begin', envelope });
    await call({ kind: 'migration.begin', operationId: 'begin-retry', envelope });
    const changed = manifest(fixture, envelope.migrationId); changed.source.sourceProfileId = 'different-profile';
    const { fingerprint: _old, ...unsigned } = changed; changed.fingerprint = fingerprint(unsigned);
    await assert.rejects(call({ kind: 'migration.begin', operationId: 'changed', envelope: changed }), { code: 'MIGRATION_CONFLICT' });
    for (let index = 0; index < fixture.length; index++) {
      await call({ kind: 'migration.record', operationId: `record-${index}`, migrationId: envelope.migrationId, itemId: `record-${index}`, record: fixture[index] });
    }
    const partial = await call({ kind: 'migration.verify', operationId: 'missing-media', migrationId: envelope.migrationId });
    assert.equal(partial.state, 'importing'); assert.ok(partial.blockers.length);
    assert.equal((await call({ kind: 'listArtworks' })).items.length, 0);
    await call({ kind: 'migration.media', operationId: 'partial', migrationId: envelope.migrationId, alias: 'visible', offset: 0, data: bytes.subarray(0, 20) });
    engine.close();
    engine = openWorkspaceEngine({ root, workspaceId: context.workspaceId, writerEpoch: 'fixture-reopen', create: false });
    await call({ kind: 'migration.media', operationId: 'resume', migrationId: envelope.migrationId, alias: 'visible', offset: 20, data: bytes.subarray(20) });
    for (const alias of ['trash', 'temporary']) await call({ kind: 'migration.media', operationId: alias, migrationId: envelope.migrationId, alias, offset: 0, data: bytes });
    const verified = await call({ kind: 'migration.verify', operationId: 'verify', migrationId: envelope.migrationId });
    assert.equal(verified.state, 'verified'); assert.deepEqual(verified.blockers, []);
    assert.equal(verified.importedRecords, fixture.length); assert.equal(verified.importedMedia, 3);
    assert.deepEqual(await call({ kind: 'migration.verify', operationId: 'verify-again', migrationId: envelope.migrationId }), verified);
    const visible = await call({ kind: 'listArtworks' });
    assert.equal(visible.items.length, 1); assert.deepEqual(visible.items[0].body.future, { raw: ['retained'] });
    assert.deepEqual((await call({ kind: 'listProjects' })).items[0].body.history_ids, [42]);
    assert.equal((await call({ kind: 'readMedia', alias: 'temporary' })).totalBytes, bytes.length);
    const deleted = await call({ kind: 'getArtwork', id: '43' });
    await call({ kind: 'restoreArtwork', operationId: 'restore', id: '43', expectedRevision: deleted!.revision });
    assert.deepEqual((await call({ kind: 'listProjects' })).items[0].body.history_ids, [42, '43']);
    const settings = await call({ kind: 'profile.readSettings' });
    assert.equal(settings.records.find(record => record.key === 'aics_theme')?.value, 'dark');
    assert.equal((await call({ kind: 'profile.readDrafts', windowId: 'main' })).records.length, 1);
    assert.equal((await call({ kind: 'profile.readDrafts', windowId: 'chat' })).records.length, 0);
    await call({ kind: 'profile.resetChat', operationId: 'reset-new', expectedReset: 'reset-stamp' });
    await assert.rejects(call({ kind: 'profile.saveChatRecord', operationId: 'stale-chat', key: 'aics_chat_v1', value: '{}', expectedRevision: null, expectedReset: 'reset-stamp' }), { code: 'PROFILE_RESET_CONFLICT' });
    const snapshot = await call({ kind: 'profile.readChat' });
    assert.equal(snapshot.resetRevision, 'reset-new');
    assert.equal(snapshot.records.some(record => record.key === 'aics_chat_archive_v1'), false);
    console.log('Migration/profile: complete original/trash/temporary-media roundtrip, resumable checkpoint, identity conflict and reset protection passed in isolated workspace.');
  } finally { engine.close(); fs.rmSync(root, { recursive: true, force: true }); }
}
void run().catch(error => { console.error(error); process.exitCode = 1; });
