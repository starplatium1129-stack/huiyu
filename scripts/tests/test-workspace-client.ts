import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { openWorkspace, type WorkspaceService } from '../../server/workspace/client';
import { readWorkspaceOwner, releaseExitedWorkspaceOwner, type WorkspaceOwner } from '../../server/workspace/owner';
import { WorkspaceError, type WorkspaceContext } from '../../server/workspace/types';

const workspaceId = 'isolated-workspace';
const context: WorkspaceContext = { workspaceId, principalId: 'desktop-owner', protocolVersion: 1 };
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64');
const hash = createHash('sha256').update(image).digest('hex');
function fixture(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huiyu-workspace-worker-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('huiyu-workspace-worker-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}
async function prepare(service: WorkspaceService) {
  return service.request({ kind: 'prepareSave', operationId: 'save-1', artwork: { id: 42, image_id: 'original', prompt: 'Neutral test image' },
    media: { alias: 'original', sha256: hash, bytes: image.length, mime: 'image/png' } }, context);
}

test('a workspace owns one worker and closes before another writer can reopen its receipts', async t => {
  const root = fixture(t);
  const service = await openWorkspace({ root, workspaceId, create: true });
  const epoch = service.runtimeEpoch;
  try {
    await assert.rejects(openWorkspace({ root, workspaceId }), { code: 'WORKSPACE_LOCKED' });
    await prepare(service);
    await service.request({ kind: 'uploadChunk', operationId: 'save-1', offset: 0, data: image }, context);
    const receipt = await service.request({ kind: 'commitSave', operationId: 'save-1' }, context);
    assert.equal(receipt.artwork?.body.prompt, 'Neutral test image');
  } finally { await service.close(); }
  const reopened = await openWorkspace({ root, workspaceId });
  try {
    assert.notEqual(reopened.runtimeEpoch, epoch);
    assert.equal((await reopened.request({ kind: 'getOperation', operationId: 'save-1' }, context))?.state, 'committed');
    await reopened.request({ kind: 'commitSave', operationId: 'save-1' }, context);
    assert.equal((await reopened.request({ kind: 'listArtworks' }, context)).items.length, 1);
    assert.deepEqual(Buffer.from((await reopened.request({ kind: 'readMedia', alias: 'original' }, context)).data), image);
  } finally { await reopened.close(); }
});

test('cancelled waits retain accepted save identity so the same operation can be reconciled', async t => {
  const root = fixture(t);
  const service = await openWorkspace({ root, workspaceId, create: true });
  try {
    await prepare(service);
    const controller = new AbortController();
    const pending = service.request({ kind: 'uploadChunk', operationId: 'save-1', offset: 0, data: image }, context, { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, (error: unknown) => error instanceof WorkspaceError && error.code === 'COMMIT_UNKNOWN');
    const operation = await service.request({ kind: 'getOperation', operationId: 'save-1' }, context);
    assert.equal(operation?.state, 'prepared');
    // Cancellation can race the bounded disk write; either offset is resumable.
    assert.ok([0, image.length].includes(operation?.media?.writtenBytes ?? -1));
    await service.request({ kind: 'uploadChunk', operationId: 'save-1', offset: 0, data: image }, context);
    const receipt = await service.request({ kind: 'commitSave', operationId: 'save-1' }, context);
    assert.equal(receipt.artwork?.id, 42);
  } finally { await service.close(); }
});

test('a second process cannot steal a live or orphaned owner; host recovery requires its exited child', async t => {
  const root = fixture(t);
  const child = spawn(process.execPath, ['-e', `
    const {openWorkspace}=require(process.argv[1]);
    const {readWorkspaceOwner}=require(process.argv[2]);
    (async()=>{const service=await openWorkspace({root:process.argv[3],workspaceId:'${workspaceId}',create:true});
      process.send(readWorkspaceOwner(process.argv[3])); process.on('message',()=>{});
    })().catch(error=>{console.error(error);process.exit(1)});`,
  require.resolve('../../server/workspace/client'), require.resolve('../../server/workspace/owner'), root],
  { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
  let stderr = '';
  child.stderr?.on('data', bytes => { stderr += String(bytes); });
  const exit = new Promise<void>(resolve => child.once('exit', () => resolve()));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exit; });
  const owner = await new Promise<WorkspaceOwner>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Workspace child startup timeout: ' + stderr)); }, 10_000);
    child.once('message', value => { clearTimeout(timer); resolve(value as WorkspaceOwner); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Workspace child exited before ready: ' + stderr)); });
  });
  await assert.rejects(openWorkspace({ root, workspaceId }), { code: 'WORKSPACE_LOCKED' });
  assert.throws(() => releaseExitedWorkspaceOwner(root, owner, child), { code: 'WORKSPACE_OWNER_UNCONFIRMED' });
  child.kill('SIGKILL');
  await exit;
  assert.deepEqual(readWorkspaceOwner(root), owner);
  await assert.rejects(openWorkspace({ root, workspaceId }), { code: 'WORKSPACE_LOCKED' });
  assert.throws(() => releaseExitedWorkspaceOwner(root, { ...owner, nonce: 'different' }, child), { code: 'WORKSPACE_LOCK_CHANGED' });
  releaseExitedWorkspaceOwner(root, owner, child);
  const reopened = await openWorkspace({ root, workspaceId });
  await reopened.close();
});
