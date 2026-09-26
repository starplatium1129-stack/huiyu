import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { openStorage } from '../../server/workspace/schema';
import { executeTaskCommand } from '../../server/workspace/tasks';
import { TASK_SCHEMA_SQL } from '../../server/workspace/task-schema';
import { createTaskRuntime } from '../../server/tasks/runtime';
import type { TaskProvider, TaskExecutionHooks, TaskObservation } from '../../server/tasks/provider';
import type { TaskRecord } from '../../types/tasks';
import type { TaskCommand } from '../../server/workspace/task-types';
import animaFactory = require('../../routes/anima/service');
import animaValidation = require('../../routes/anima/validation');
import batchFactory = require('../../routes/video/batch');
import videoValidation = require('../../routes/video/validation');
import videoConstants = require('../../routes/video/constants');
import { mediaPath } from '../../server/workspace/media';

const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jM1sAAAAASUVORK5CYII=', 'base64');
const immediate = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(predicate: () => Promise<boolean>) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('Task did not converge');
}
function fixture(submit?: (task: TaskRecord, hooks: TaskExecutionHooks) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huiyu-task-fixture-'));
  const storage = openStorage({ root, workspaceId: 'task-fixture', writerEpoch: 'epoch-one', create: true });
  if (!storage.db.prepare("SELECT name FROM sqlite_master WHERE name='tasks'").get()) storage.db.exec(TASK_SCHEMA_SQL);
  let submissions = 0, cancellations = 0, fingerprint = 'approved-binding';
  let observation: TaskObservation = { status: 'running', settled: false };
  const provider: TaskProvider = {
    fingerprint: () => fingerprint, validate: input => input,
    async submit(task, hooks) { submissions++; if (submit) await submit(task, hooks); else { await hooks.submitting('fake', fingerprint); await hooks.observed('prompt-one'); } },
    async query() { return observation; }, async cancel() { cancellations++; },
  };
  const workspace = { workspaceId: 'task-fixture', runtimeEpoch: 'epoch-one', async request(command: TaskCommand | { kind: 'readMedia'; alias: string; offset: number }, context: { principalId: string; workspaceId: string; protocolVersion: 1 }) {
    if (command.kind === 'readMedia') {
      const media = storage.db.prepare('SELECT m.* FROM media_objects m JOIN media_aliases a ON a.hash=m.hash WHERE a.alias=?').get(command.alias)!;
      const bytes = fs.readFileSync(mediaPath(root, String(media.hash)));
      return { data: bytes.subarray(command.offset, command.offset + 1024 * 1024), totalBytes: bytes.length, mime: String(media.mime), sha256: String(media.hash), offset: command.offset };
    }
    return executeTaskCommand(storage, command, context);
  } };
  let runtime = createTaskRuntime({ workspace, providers: { anima: provider }, pollMs: 60000 });
  return { root, storage, workspace, get runtime() { return runtime; }, get submissions() { return submissions; }, get cancellations() { return cancellations; },
    observe(value: TaskObservation) { observation = value; }, changeBinding() { fingerprint = 'replacement-backend'; },
    async restart() { await runtime.close(); runtime = createTaskRuntime({ workspace: { ...workspace, runtimeEpoch: 'epoch-two' }, providers: { anima: provider }, pollMs: 60000 }); },
    async close() { await runtime.close(); storage.db.close(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}
const request = { kind: 'anima' as const, requestKey: 'same-click', input: { prompt: 'fixture', seed: 42 } };

test('accepted response loss retries the same identity; conflicts and foreign owners cannot expose a task', async () => {
  const f = fixture();
  try {
    const first = await f.runtime.submit('desktop', request);
    const retry = await f.runtime.submit('desktop', request);
    assert.equal(first.taskId, retry.taskId);
    await until(async () => Boolean((await f.runtime.get('desktop', first.taskId)).upstreamId));
    assert.equal(f.submissions, 1);
    await assert.rejects(f.runtime.submit('desktop', { ...request, input: { prompt: 'changed' } }), { code: 'TASK_KEY_CONFLICT' });
    await assert.rejects(f.runtime.get('remote-token', first.taskId), { code: 'TASK_NOT_FOUND' });
  } finally { await f.close(); }
});

test('lost upstream ID remains unknown across repeated restarts and blocks duplicate GPU admission', async () => {
  const f = fixture(async (_task, hooks) => { await hooks.submitting('fake', 'approved-binding'); throw new Error('reply lost'); });
  try {
    const task = await f.runtime.submit('desktop', request);
    await until(async () => (await f.runtime.get('desktop', task.taskId)).recoveryState === 'unknown');
    f.observe({ status: 'submitting', settled: false, unknown: true });
    for (let i = 0; i < 2; i++) { await f.restart(); await f.runtime.recover('desktop'); }
    assert.equal(f.submissions, 1);
    await assert.rejects(f.runtime.submit('desktop', { ...request, requestKey: 'second-click' }), { code: 'TASK_PROVIDER_BUSY' });
    assert.equal((await f.runtime.get('desktop', task.taskId)).upstreamSettled, false);
  } finally { await f.close(); }
});

test('cancellation by request key survives create in flight and late IDs keep the intent', async () => {
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(async (_task, hooks) => { await hooks.submitting('fake', 'approved-binding'); await barrier; await hooks.observed('late-id'); });
  try {
    await f.runtime.cancel('desktop', 'cancel-before-create');
    const cancelled = await f.runtime.submit('desktop', { ...request, requestKey: 'cancel-before-create' });
    assert.equal(cancelled.status, 'cancelled'); assert.equal(f.submissions, 0);
    const task = await f.runtime.submit('desktop', request);
    await until(async () => Boolean((await f.runtime.get('desktop', task.taskId)).submissionIntentAt));
    await f.runtime.cancel('desktop', request.requestKey); release();
    await until(async () => (await f.runtime.get('desktop', task.taskId)).upstreamId === 'late-id');
    const current = await f.runtime.get('desktop', task.taskId);
    assert.equal(current.status, 'cancelling'); assert.ok(current.cancelRequestedAt);
    f.observe({ status: 'succeeded', settled: true, outputs: [{ bytes: image, mime: 'image/png' }] });
    await until(async () => { await f.runtime.reconcile('desktop', task.taskId); return (await f.runtime.get('desktop', task.taskId)).resultState === 'available'; });
    const final = await f.runtime.get('desktop', task.taskId);
    assert.equal(final.status, 'cancelled'); assert.equal(final.deliveryState, 'unseen');
    assert.equal(Number(f.storage.db.prepare('SELECT count(*) AS n FROM artworks').get()?.n), 0);
  } finally { release(); await immediate(); await f.close(); }
});

test('collector publishes verified inbox media without artwork creation; restart only re-reads results', async () => {
  const f = fixture();
  try {
    const task = await f.runtime.submit('desktop', request);
    await until(async () => Boolean((await f.runtime.get('desktop', task.taskId)).upstreamId));
    f.observe({ status: 'succeeded', settled: true, outputs: [{ bytes: image, mime: 'image/png' }] });
    await until(async () => { await f.runtime.reconcile('desktop', task.taskId); return (await f.runtime.get('desktop', task.taskId)).resultState === 'available'; });
    const result = await f.runtime.get('desktop', task.taskId);
    assert.equal(result.resultRefs[0].bytes, image.length);
    assert.equal(Number(f.storage.db.prepare("SELECT count(*) AS n FROM media_refs WHERE owner_kind='task-result'").get()?.n), 1);
    assert.equal(Number(f.storage.db.prepare('SELECT count(*) AS n FROM artworks').get()?.n), 0);
    await f.restart(); await f.runtime.recover('desktop'); assert.equal(f.submissions, 1);
    await f.runtime.cancel('desktop', request.requestKey);
    assert.equal((await f.runtime.get('desktop', task.taskId)).status, 'succeeded');
  } finally { await f.close(); }
});

test('changed backend binding never queries or cancels the replacement', async () => {
  const f = fixture();
  try {
    const task = await f.runtime.submit('desktop', request);
    await until(async () => Boolean((await f.runtime.get('desktop', task.taskId)).upstreamId));
    f.changeBinding(); await f.runtime.cancel('desktop', request.requestKey);
    const value = await f.runtime.reconcile('desktop', task.taskId);
    assert.equal(value.recoveryState, 'unknown'); assert.equal(value.errorCode, 'PROVIDER_IDENTITY_CHANGED'); assert.equal(f.cancellations, 0);
  } finally { await immediate(); await f.close(); }
});

test('existing Comfy service awaits durable intent and prompt identity, then collects without any page polling', async () => {
  const events: string[] = []; let submissions = 0;
  const upstream = http.createServer((req, res) => {
    req.resume(); res.setHeader('Content-Type', 'application/json');
    if (req.url === '/prompt') { submissions++; events.push('upstream-post'); res.end(JSON.stringify({ prompt_id: 'persistent-prompt' })); }
    else if (req.url?.startsWith('/history/')) res.end(JSON.stringify({ 'persistent-prompt': { status: { status_str: 'success' }, outputs: { '10': { images: [{ filename: 'anima_app_fixture.png', subfolder: '', type: 'output' }] } } } }));
    else if (req.url?.startsWith('/view')) { res.setHeader('Content-Type', 'image/png'); res.end(image); }
    else res.end('{}');
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const port = (upstream.address() as import('node:net').AddressInfo).port;
  let service: ReturnType<typeof animaFactory.createAnimaService>;
  const f = fixture(async (task, hooks) => {
    const input = animaValidation.validateInput({ prompt: 'fixture', modelId: 'anima-aesthetic-v1.1', width: 832, height: 1216, seed: 42 });
    const job = service.create(input, task.principalId);
    await service.submit(job, {
      ...hooks,
      async submitting(provider, fingerprint) { await hooks.submitting(provider, fingerprint || 'approved-binding'); events.push('intent-durable'); },
      async observed(id, metadata) { await hooks.observed(id, metadata); events.push('id-durable'); },
      async collect(outputs) { await hooks.collect(outputs); events.push('inbox-durable'); },
    });
  });
  service = animaFactory.createAnimaService({ ROOT_DIR: f.root, COMFY_HOST: `http://127.0.0.1:${port}`, RUNTIME: { state: path.join(f.root, 'runtime', 'state'), outputs: path.join(f.root, 'runtime', 'outputs') } }, { durableTasks: true, validateResources: () => {}, buildWorkflow: () => ({}) });
  try {
    const task = await f.runtime.submit('desktop', request);
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && (await f.runtime.get('desktop', task.taskId)).resultState !== 'available') await new Promise(resolve => setTimeout(resolve, 10));
    const final = await f.runtime.get('desktop', task.taskId);
    assert.equal(final.upstreamId, 'persistent-prompt'); assert.equal(final.resultState, 'available'); assert.equal(submissions, 1);
    assert.deepEqual(events, ['intent-durable', 'upstream-post', 'id-durable', 'inbox-durable']);
    assert.equal(Number(f.storage.db.prepare('SELECT count(*) AS n FROM artworks').get()?.n), 0);
  } finally { service.close(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); await f.close(); }
});

test('input media is protected in workspace and reconstructs provider files without generating again', async () => {
  let source = '', copied = '';
  const f = fixture(async (_task, hooks) => {
    await hooks.protectInput!('first-frame.png', source);
    fs.unlinkSync(source);
    assert.equal(await hooks.restoreInput!('first-frame.png', copied), true);
    await hooks.submitting('fake', 'approved-binding'); await hooks.observed('input-prompt');
  });
  source = path.join(f.root, 'source.png'); copied = path.join(f.root, 'restored', 'first-frame.png'); fs.writeFileSync(source, image);
  try {
    const task = await f.runtime.submit('desktop', request);
    await until(async () => Boolean((await f.runtime.get('desktop', task.taskId)).upstreamId));
    const current = await f.runtime.get('desktop', task.taskId);
    assert.equal(current.inputMediaRefs.length, 1); assert.deepEqual(fs.readFileSync(copied), image);
    assert.equal(Number(f.storage.db.prepare("SELECT count(*) AS n FROM media_refs WHERE owner_kind='task-input'").get()?.n), 1);
    assert.equal(current.resultRefs.length, 0); assert.equal(f.submissions, 1);
  } finally { await f.close(); }
});

test('shutdown drains an in-flight upstream identity write before the workspace can close', async () => {
  let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(async (_task, hooks) => { await hooks.submitting('fake', 'approved-binding'); await barrier; await hooks.observed('late-shutdown-id'); });
  try {
    const task = await f.runtime.submit('desktop', request);
    await until(async () => Boolean((await f.runtime.get('desktop', task.taskId)).submissionIntentAt));
    let finished = false; const closing = f.runtime.close().then(() => { finished = true; });
    await immediate(); assert.equal(finished, false);
    release(); await closing;
    assert.equal((await f.runtime.get('desktop', task.taskId)).upstreamId, 'late-shutdown-id');
    await assert.rejects(f.runtime.submit('desktop', { ...request, requestKey: 'after-close' }), { code: 'TASK_RUNTIME_CLOSED' });
  } finally { release(); await f.close(); }
});

test('discard releases only settled task results and never resurrects them during recovery', async () => {
  const f = fixture();
  try {
    const task = await f.runtime.submit('desktop', request);
    await until(async () => Boolean((await f.runtime.get('desktop', task.taskId)).upstreamId));
    await assert.rejects(f.runtime.delivery('desktop', task.taskId, 'discarded'), { code: 'TASK_DISCARD_UNSAFE' });
    f.observe({ status: 'succeeded', settled: true, outputs: [{ bytes: image, mime: 'image/png' }] });
    await until(async () => { await f.runtime.reconcile('desktop', task.taskId); return (await f.runtime.get('desktop', task.taskId)).upstreamSettled; });
    const completed = await f.runtime.get('desktop', task.taskId), media = completed.resultRefs[0];
    f.storage.db.prepare('INSERT INTO media_refs VALUES(?,?,?)').run('artwork', 'saved-fixture', media.sha256);
    await f.runtime.delivery('desktop', task.taskId, 'saved'); await f.runtime.delivery('desktop', task.taskId, 'seen');
    assert.equal((await f.runtime.get('desktop', task.taskId)).deliveryState, 'saved');
    await f.runtime.delivery('desktop', task.taskId, 'discarded');
    await f.runtime.delivery('desktop', task.taskId, 'seen');
    await f.runtime.recover('desktop'); await f.runtime.reconcile('desktop', task.taskId);
    const discarded = await f.runtime.get('desktop', task.taskId);
    assert.equal(discarded.deliveryState, 'discarded'); assert.deepEqual(discarded.resultRefs, []);
    assert.equal(Number(f.storage.db.prepare("SELECT count(*) AS n FROM media_refs WHERE owner_kind='task-result'").get()?.n), 0);
    assert.equal(Number(f.storage.db.prepare("SELECT count(*) AS n FROM media_refs WHERE owner_kind='artwork'").get()?.n), 1);
    assert.equal((await f.runtime.submit('desktop', request)).taskId, task.taskId); assert.equal(f.submissions, 1);
  } finally { await f.close(); }
});

test('migrated legacy task summaries are read-only and scoped to their verified principal', async () => {
  const f = fixture();
  try {
    const summary = { version: 1, records: [{ id: 'legacy-task', title: '原窗口摘要', status: 'interrupted' }], deleted: { removed: 123 } };
    f.storage.db.prepare('INSERT INTO migration_sessions VALUES(?,?,?,?,?,?,?)').run('old-origin', 'desktop', 'fixture', '{}', 'verified', '{}', 1);
    f.storage.db.prepare('INSERT INTO migration_items VALUES(?,?,?,?)').run('old-origin', 'tasks', 'fixture', JSON.stringify({ source: 'kv', key: 'aics_task_center_v1', domain: 'history', value: summary }));
    assert.deepEqual((await f.runtime.legacyHistory('desktop')).snapshots, [summary]);
    assert.deepEqual((await f.runtime.legacyHistory('other-principal')).snapshots, []);
    assert.equal(Number(f.storage.db.prepare('SELECT count(*) AS n FROM tasks').get()?.n), 0);
  } finally { await f.close(); }
});

test('restored batch stays paused and explicit continuation submits only the never sent shot', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huiyu-batch-fixture-'));
  const config = { ROOT_DIR: root, AI_WORKSPACE_ROOT: root, COMFY_HOST: 'http://127.0.0.1:1' };
  const model = videoConstants.MODEL_BY_ID['wan2.2-ti2v-5b'];
  for (const [folder, name] of model.requirements) { const file = path.join(root, 'ComfyUI', 'models', folder, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'fixture'); }
  const input = videoValidation.validateBatchInput({ modelId: model.id, aspectRatio: 'landscape', linkLastFrame: false,
    shots: [{ prompt: 'first fixture', seed: 11 }, { prompt: 'second fixture', seed: 22 }] }, config, { isLocal: true });
  const submitted: number[] = []; const checkpoints: Record<string, unknown>[] = [];
  const jobs = new Map<string, any>();
  const fakeVideo = {
    create(value: any) { const job = { id: 'new-shot', input: value, status: 'queued', upstreamId: '', result: null }; jobs.set(job.id, job); return job; },
    async submit(job: any, hooks: TaskExecutionHooks) { await hooks.submitting('comfy', 'fixture'); submitted.push(job.input.seed); job.upstreamId = 'second-prompt'; await hooks.observed(job.upstreamId); job.status = 'running'; },
    get(id: string) { return jobs.get(id); }, async cancel() {},
  };
  const batches = batchFactory.createBatchService(config, fakeVideo, { batchPollIntervalMs: 5 });
  const hooks: TaskExecutionHooks = { async submitting() {}, async observed() {}, async collect() {}, async checkpoint(value) { checkpoints.push(structuredClone(value)); } };
  const previousResult = path.join(root, 'first.mp4'); fs.writeFileSync(previousResult, 'fixture');
  try {
    const recovered = { shots: input.shots.map((shot: any, index: number) => ({ index: index + 1, input: shot.input, attempts: index ? 0 : 1,
      status: index ? 'pending' : 'succeeded', upstreamId: index ? null : 'first-prompt', submissionIntentAt: index ? null : 123,
      gatewayJobId: index ? null : 'first-job', result: index ? null : { path: previousResult, mime: 'video/mp4' }, tailFrame: index ? null : 'preserved-frame.png' })) };
    const batch = await batches.create('desktop', input, hooks, recovered);
    assert.equal(batch.status, 'paused'); assert.deepEqual(submitted, []);
    await batches.resume(batch);
    await until(async () => submitted.length === 1 && Boolean((checkpoints.at(-1)?.shots as any[])?.[1].upstreamId));
    assert.deepEqual(submitted, [22]);
    const shots = checkpoints.at(-1)?.shots as any[];
    assert.equal(shots[0].upstreamId, 'first-prompt'); assert.equal(shots[0].tailFrame, 'preserved-frame.png');
    assert.equal(shots[1].upstreamId, 'second-prompt'); assert.ok(shots[1].submissionIntentAt);
  } finally { batches.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
