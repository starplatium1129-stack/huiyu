import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { openWorkspaceEngine } from '../../server/workspace/engine';
import { digest, mediaPath, stagingPath } from '../../server/workspace/media';
import { taskInputStagingKey, taskOutputStagingKey } from '../../server/workspace/task-media-keys';
import { TRASH_RETENTION_MS } from '../../server/workspace/records';
import type { Checkpoint, EntityId, WorkspaceCommand, WorkspaceContext, WorkspaceResults } from '../../server/workspace/types';
import type { TaskRecord } from '../../types/tasks';

const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jM1sAAAAASUVORK5CYII=', 'base64');
const media = { alias: 'image-1', sha256: digest(bytes), bytes: bytes.length, mime: 'image/png' };
const context: WorkspaceContext = { workspaceId: 'workspace-fixture', principalId: 'desktop-fixture', protocolVersion: 1 };
const prepare: Extract<WorkspaceCommand, { kind: 'prepareSave' }> = {
  kind: 'prepareSave', operationId: 'save-1', artwork: { id: 42, image_id: media.alias, custom_future_field: { nested: [true, 'kept'] } }, media,
};
type Engine = ReturnType<typeof openWorkspaceEngine>;
const open = (root: string, create = false, onCheckpoint?: (phase: Checkpoint) => void) =>
  openWorkspaceEngine({ root, workspaceId: context.workspaceId, writerEpoch: 'fixture-epoch', create, onCheckpoint });
async function call<K extends WorkspaceCommand['kind']>(engine: Engine, command: Extract<WorkspaceCommand, { kind: K }>, principal = context.principalId): Promise<WorkspaceResults[K]> {
  return engine.execute(command, { ...context, principalId: principal }) as Promise<WorkspaceResults[K]>;
}
async function save(engine: Engine, id: EntityId = 42, operationId = 'save-1', alias = 'image-1') {
  await call(engine, { ...prepare, operationId, artwork: { ...prepare.artwork, id, image_id: alias }, media: { ...media, alias } });
  await call(engine, { kind: 'uploadChunk', operationId, offset: 0, data: bytes });
  return call(engine, { kind: 'commitSave', operationId });
}
function changeDatabase(root: string, action: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(path.join(root, 'huiyu.sqlite3'));
  try { action(db); } finally { db.close(); }
}
async function crashChild(): Promise<void> {
  const phase = process.argv[4] as Checkpoint;
  const engine = open(process.argv[3], true, current => {
    if (current !== phase) return;
    fs.writeSync(1, `checkpoint:${phase}\n`);
    process.kill(process.pid, 'SIGKILL');
  });
  await save(engine);
  throw new Error('Crash checkpoint was not reached');
}

async function run(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huiyu-workspace-storage-'));
  let assertions = 0;
  try {
    for (const phase of ['prepared', 'media-published', 'metadata-written', 'committed'] as const) {
      const directory = path.join(root, phase);
      const child = spawnSync(process.execPath, [__filename, '--crash', directory, phase], { timeout: 15000, encoding: 'utf8', windowsHide: true });
      assert.ifError(child.error);
      assert.equal(child.stdout.trim(), `checkpoint:${phase}`, child.stderr);
      assert.notEqual(child.status, 0, 'checkpoint must terminate the writer without cleanup');
      const engine = open(directory);
      try {
        const before = await call(engine, { kind: 'getOperation', operationId: 'save-1' });
        assert.equal(before?.state, phase === 'committed' ? 'committed' : 'prepared');
        assert.equal((await call(engine, { kind: 'listArtworks' })).items.length, phase === 'committed' ? 1 : 0);
        const receipt = await save(engine);
        assert.deepEqual(await call(engine, { kind: 'commitSave', operationId: 'save-1' }), receipt);
        assert.equal((await call(engine, { kind: 'listArtworks' })).items.length, 1);
        assert.deepEqual(receipt.artwork?.body.custom_future_field, { nested: [true, 'kept'] });
        assert.equal(await call(engine, { kind: 'getOperation', operationId: 'save-1' }, 'other-principal'), null);
        await assert.rejects(call(engine, { ...prepare, artwork: { ...prepare.artwork, note: 'different' } }), { code: 'OPERATION_CONFLICT' });
        assertions += 8;
      } finally { engine.close(); }
    }
    const directory = path.join(root, 'domains');
    let engine = open(directory, true);
    try {
      await call(engine, prepare);
      const first = bytes.subarray(0, 20);
      assert.equal((await call(engine, { kind: 'uploadChunk', operationId: 'save-1', offset: 0, data: first })).offset, 20);
      assert.equal((await call(engine, { kind: 'uploadChunk', operationId: 'save-1', offset: 0, data: first })).offset, 20);
      await assert.rejects(call(engine, { kind: 'uploadChunk', operationId: 'save-1', offset: 0, data: Buffer.alloc(20) }), { code: 'OPERATION_CONFLICT' });
      engine.close(); engine = open(directory);
      assert.equal((await call(engine, { kind: 'getOperation', operationId: 'save-1' }))?.media?.writtenBytes, 20);
      await call(engine, { kind: 'uploadChunk', operationId: 'save-1', offset: 20, data: bytes.subarray(20) });
      const numeric = await call(engine, { kind: 'commitSave', operationId: 'save-1' });
      await assert.rejects(save(engine, '42', 'save-collision', 'image-collision'), { code: 'OPERATION_CONFLICT' });
      const string = await save(engine, '43', 'save-2', 'image-2');
      const firstPage = await call(engine, { kind: 'listArtworks', limit: 1 });
      assert.deepEqual(firstPage.items.map(row => row.id), [42]);
      const secondPage = await call(engine, { kind: 'listArtworks', limit: 1, cursor: firstPage.nextCursor! });
      assert.deepEqual(secondPage.items.map(row => row.id), ['43']);
      assert.equal(secondPage.nextCursor, null);
      const ordered = await call(engine, { kind: 'getArtworks', ids: ['43', 42, 'missing', 42] });
      assert.deepEqual(ordered.map(row => row?.id ?? null), ['43', 42, null, 42]);
      assert.notEqual(ordered[1]!.body, ordered[3]!.body);
      const project = await call(engine, { kind: 'saveProject', operationId: 'project-1', project: { id: 'project', future: 'preserved' }, artworkIds: [42, '43'], expectedRevision: null });
      assert.deepEqual(project.project?.body.history_ids, [42, '43']);
      await assert.rejects(call(engine, { kind: 'saveProject', operationId: 'project-dangling', project: { id: 'bad' }, artworkIds: ['missing'], expectedRevision: null }), { code: 'NOT_FOUND' });
      await assert.rejects(call(engine, { kind: 'patchArtwork', operationId: 'patch-stale', id: 42, expectedRevision: 0, patch: { note: 'stale' } }), { code: 'REVISION_CONFLICT' });
      const patched = await call(engine, { kind: 'patchArtwork', operationId: 'patch-ok', id: 42, expectedRevision: numeric.revision, patch: { note: 'saved' } });
      const deletion = await call(engine, { kind: 'softDeleteArtwork', operationId: 'delete-1', id: 42, expectedRevision: patched.revision });
      assert.deepEqual((await call(engine, { kind: 'listProjects' })).items[0].body.history_ids, ['43']);
      const restored = await call(engine, { kind: 'restoreArtwork', operationId: 'restore-1', id: 42, expectedRevision: deletion.revision });
      assert.deepEqual((await call(engine, { kind: 'listProjects' })).items[0].body.history_ids, [42, '43']);
      assert.equal(restored.artwork?.body.note, 'saved');
      await call(engine, { kind: 'softDeleteArtwork', operationId: 'delete-2', id: 42, expectedRevision: restored.revision });
      engine.close();
      changeDatabase(directory, db => db.prepare('UPDATE trash SET deleted_at=?').run(Date.now() - TRASH_RETENTION_MS - 1000));
      engine = open(directory);
      assert.equal((await call(engine, { kind: 'purgeExpiredTrash', operationId: 'purge-1' })).purged, 1);
      const object = mediaPath(directory, media.sha256);
      const old = new Date(Date.now() - TRASH_RETENTION_MS - 1000);
      fs.utimesSync(object, old, old);
      assert.equal((await call(engine, { kind: 'collectGarbage', operationId: 'gc-shared' })).removed, 0);
      assert.deepEqual(Buffer.from((await call(engine, { kind: 'readMedia', alias: 'image-2' })).data), bytes);
      await call(engine, { kind: 'softDeleteArtwork', operationId: 'delete-3', id: '43', expectedRevision: string.revision });
      await call(engine, { ...prepare, operationId: 'pending-save', artwork: { id: 'pending' } });
      engine.close();
      changeDatabase(directory, db => db.prepare('UPDATE trash SET deleted_at=?').run(Date.now() - TRASH_RETENTION_MS - 1000));
      engine = open(directory);
      await call(engine, { kind: 'purgeExpiredTrash', operationId: 'purge-2' });
      assert.equal((await call(engine, { kind: 'collectGarbage', operationId: 'gc-leased' })).removed, 0);
      await call(engine, { kind: 'abortSave', operationId: 'pending-save' });
      assert.equal((await call(engine, { kind: 'collectGarbage', operationId: 'gc-free' })).removed, 1);
      assert.equal(fs.existsSync(object), false);
      assertions += 22;
    } finally { engine.close(); }

    const batches = path.join(root, 'batches');
    let rejectBatch = false;
    engine = open(batches, true, phase => { if (rejectBatch && phase === 'metadata-written') throw new Error('fixture commit failure'); });
    try {
      const first = await save(engine, 'a', 'batch-save-a', 'batch-image-a');
      const second = await save(engine, 'b', 'batch-save-b', 'batch-image-b');
      await call(engine, { kind: 'saveProject', operationId: 'batch-project', project: { id: 'album' }, artworkIds: ['a', 'b'], expectedRevision: null });
      const lookup = await call(engine, { kind: 'getArtworks', ids: ['a', 'b', 'missing'] });
      assert.deepEqual(lookup.map(item => item?.revision ?? null), [first.revision, second.revision, null]);
      const command: Extract<WorkspaceCommand, { kind: 'softDeleteArtworks' }> = { kind: 'softDeleteArtworks', operationId: 'batch-delete',
        items: [{ id: 'a', expectedRevision: first.revision }, { id: 'b', expectedRevision: second.revision }] };
      rejectBatch = true;
      await assert.rejects(call(engine, command), /fixture commit failure/);
      rejectBatch = false;
      assert.equal((await call(engine, { kind: 'listArtworks' })).items.length, 2);
      assert.deepEqual((await call(engine, { kind: 'listProjects' })).items[0].body.history_ids, ['a', 'b']);
      assert.equal(await call(engine, { kind: 'getOperation', operationId: command.operationId }), null);
      let checks = 0;
      await assert.rejects(engine.execute(command, context, { isCancelled: () => ++checks === 3 }), { code: 'CANCELLED' });
      assert.equal((await call(engine, { kind: 'listArtworks' })).items.length, 2);
      const receipt = await call(engine, command);
      assert.deepEqual(receipt.softDeleteResults, [{ id: 'a', deleted: true }, { id: 'b', deleted: true }]);
      assert.deepEqual(await call(engine, command), receipt, 'lost acknowledgement returns the same per-item receipt');
      await assert.rejects(call(engine, { ...command, items: command.items.slice(0, 1) }), { code: 'OPERATION_CONFLICT' });
      assert.deepEqual((await call(engine, { kind: 'listProjects' })).items[0].body.history_ids, []);
      const restored = await call(engine, { kind: 'restoreArtwork', operationId: 'batch-restore-a', id: 'a', expectedRevision: receipt.revision });
      await call(engine, { kind: 'restoreArtwork', operationId: 'batch-restore-b', id: 'b', expectedRevision: receipt.revision });
      assert.deepEqual((await call(engine, { kind: 'listProjects' })).items[0].body.history_ids, ['a', 'b']);
      assert.deepEqual(Buffer.from((await call(engine, { kind: 'readMedia', alias: 'batch-image-a' })).data), bytes);
      const partial = await call(engine, { kind: 'softDeleteArtworks', operationId: 'partial-delete', items: [
        { id: 'a', expectedRevision: restored.revision }, { id: 'b', expectedRevision: 0 }, { id: 'missing', expectedRevision: 0 },
      ] });
      assert.deepEqual(partial.softDeleteResults, [{ id: 'a', deleted: true }, { id: 'b', deleted: false, code: 'REVISION_CONFLICT' }, { id: 'missing', deleted: false, code: 'NOT_FOUND' }]);
      assert.deepEqual((await call(engine, { kind: 'listProjects' })).items[0].body.history_ids, ['b']);
      assertions += 15;
    } finally { engine.close(); }

    const taskStaging = path.join(root, 'task-staging');
    engine = open(taskStaging, true);
    try {
      const now = Date.now(), taskId = 'gc-task';
      const record: TaskRecord = { taskId, workspaceId: context.workspaceId, principalId: context.principalId,
        requestKey: taskId, requestFingerprint: 'fixture', kind: 'anima', provider: 'fixture', providerFingerprint: 'fixture',
        upstreamId: 'fixture-prompt', status: 'succeeded', recoveryState: 'normal', revision: 0, runtimeEpoch: 'fixture-epoch',
        createdAt: now, updatedAt: now, submissionIntentAt: now, submissionObservedAt: now, cancelRequestedAt: null,
        upstreamSettled: true, executionDeadline: now, input: {}, inputMediaRefs: [], resultState: 'none', resultRefs: [],
        deliveryState: 'unseen', errorCode: null, metadata: {}, checkpoint: null, parentBatchId: null, stepIndex: null };
      await call(engine, { kind: 'task.accept', record });
      const resultBytes = Buffer.concat([bytes, Buffer.from('result')]);
      const resultMedia = { ...media, alias: `task-${taskId}-0`, sha256: digest(resultBytes), bytes: resultBytes.length, index: 0 };
      const inputKey = taskInputStagingKey(taskId, 'accepted.png');
      const inputMedia = { ...media, alias: `task-input-${inputKey}` };
      const pendingKey = taskInputStagingKey(taskId, 'pending.png');
      const pendingBytes = Buffer.concat([bytes, Buffer.from('pending')]);
      const pendingMedia = { ...media, alias: `task-input-${pendingKey}`, sha256: digest(pendingBytes), bytes: pendingBytes.length };
      await call(engine, { kind: 'task.result.prepare', taskId, media: resultMedia });
      await call(engine, { kind: 'task.result.chunk', taskId, index: 0, offset: 0, data: resultBytes });
      await call(engine, { kind: 'task.input.prepare', taskId, name: 'accepted.png', media: inputMedia });
      await call(engine, { kind: 'task.input.chunk', taskId, name: 'accepted.png', offset: 0, data: bytes });
      await call(engine, { kind: 'task.input.prepare', taskId, name: 'pending.png', media: pendingMedia });
      await call(engine, { kind: 'task.input.chunk', taskId, name: 'pending.png', offset: 0, data: pendingBytes });
      const resultStaged = stagingPath(taskStaging, taskOutputStagingKey(taskId, 0), resultMedia.alias);
      const inputStaged = stagingPath(taskStaging, inputKey, inputMedia.alias);
      const pendingStaged = stagingPath(taskStaging, pendingKey, pendingMedia.alias);
      const blocked = new Set([resultStaged, inputStaged]);
      const originalUnlink = fs.unlinkSync;
      fs.unlinkSync = file => {
        if (blocked.has(String(file))) { const error: NodeJS.ErrnoException = new Error('fixture staging busy'); error.code = 'EBUSY'; throw error; }
        originalUnlink(file);
      };
      try {
        await call(engine, { kind: 'task.result.commit', taskId, index: 0 });
        await call(engine, { kind: 'task.input.commit', taskId, name: 'accepted.png' });
      } finally { fs.unlinkSync = originalUnlink; }
      const committed = (await call(engine, { kind: 'task.get', taskId }))!;
      assert.equal(committed.resultState, 'available');
      await call(engine, { kind: 'task.patch', taskId, expectedRevision: committed.revision, patch: { deliveryState: 'discarded' } });
      await call(engine, { kind: 'collectGarbage', operationId: 'recent-task-gc' });
      assert.equal(fs.existsSync(resultStaged) && fs.existsSync(inputStaged), true, 'recent committed staging retains its grace period');
      const old = new Date(Date.now() - TRASH_RETENTION_MS - 1000);
      for (const file of [resultStaged, inputStaged, pendingStaged]) fs.utimesSync(file, old, old);
      assert.equal((await call(engine, { kind: 'collectGarbage', operationId: 'expired-task-gc' })).removed, 1);
      assert.equal(fs.existsSync(resultStaged), false, 'collect discarded output staging left by failed post-commit cleanup');
      assert.equal(fs.existsSync(mediaPath(taskStaging, resultMedia.sha256)), false);
      assert.equal(fs.existsSync(inputStaged), false, 'collect committed input staging without removing its authoritative original');
      assert.deepEqual(Buffer.from((await call(engine, { kind: 'readMedia', alias: inputMedia.alias })).data), bytes);
      assert.deepEqual(fs.readFileSync(pendingStaged), pendingBytes, 'an unfinished input remains resumable even after the grace period');
      changeDatabase(taskStaging, db => assert.equal(db.prepare('SELECT kind FROM leases WHERE id=?').get(pendingKey)?.kind, 'task-input'));
      assertions += 9;
    } finally { engine.close(); }

    const failures = path.join(root, 'failures');
    engine = open(failures, true);
    try {
      await call(engine, prepare);
      const originalWrite = fs.writeSync;
      fs.writeSync = (() => { const error: NodeJS.ErrnoException = new Error('fixture disk full'); error.code = 'ENOSPC'; throw error; }) as typeof fs.writeSync;
      try { await assert.rejects(call(engine, { kind: 'uploadChunk', operationId: 'save-1', offset: 0, data: bytes }), { code: 'ENOSPC' }); }
      finally { fs.writeSync = originalWrite; }
      assert.equal((await call(engine, { kind: 'listArtworks' })).items.length, 0);
      await call(engine, { kind: 'uploadChunk', operationId: 'save-1', offset: 0, data: bytes });
      let checks = 0;
      await assert.rejects(engine.execute({ kind: 'commitSave', operationId: 'save-1' }, context,
        { isCancelled: () => ++checks === 2 }), { code: 'CANCELLED' });
      await call(engine, { kind: 'commitSave', operationId: 'save-1' });
      fs.writeFileSync(mediaPath(failures, media.sha256), Buffer.alloc(bytes.length));
      await assert.rejects(call(engine, { kind: 'readMedia', alias: media.alias }), { code: 'MEDIA_INVALID' });
      assert.equal((await call(engine, { kind: 'listArtworks' })).items.length, 1);
      changeDatabase(failures, db => db.prepare("UPDATE meta SET value='new-owner' WHERE key='writerEpoch'").run());
      await assert.rejects(call(engine, { kind: 'uploadChunk', operationId: 'save-1', offset: 0, data: bytes }), { code: 'WRITER_EPOCH' });
      engine.close();
      changeDatabase(failures, db => db.exec('PRAGMA user_version=99'));
      assert.throws(() => open(failures), { code: 'WORKSPACE_SCHEMA' });
      assert.throws(() => open(path.join(root, 'missing')), { code: 'WORKSPACE_IDENTITY' });
      assertions += 8;
    } finally { engine.close(); }
    console.log(`Workspace storage: ${assertions} checks passed; four real process exits recovered, no production data accessed.`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

void (process.argv[2] === '--crash' ? crashChild() : run()).catch(error => { console.error(error); process.exitCode = 1; });
