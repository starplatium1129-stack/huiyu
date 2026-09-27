import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import threads = require('node:worker_threads');
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('WD14 cancellation retains admission until worker exit and ignores late native output', async t => {
  const instances: FakeWorker[] = [];
  class FakeWorker extends EventEmitter {
    messages: unknown[] = [];
    terminated = false;
    constructor() { super(); instances.push(this); }
    ref() { return this; }
    unref() { return this; }
    postMessage(message: unknown) { this.messages.push(message); }
    terminate() { this.terminated = true; return Promise.resolve(0); }
  }
  t.mock.method(threads, 'Worker', function () { return new FakeWorker(); } as unknown as typeof threads.Worker);
  const clientPath = require.resolve('../../server/interrogate-client');
  delete require.cache[clientPath];
  const { createInterrogateClient }: typeof import('../../server/interrogate-client') = require(clientPath);
  const client = createInterrogateClient();
  const controller = new AbortController();
  const config = { ROOT_DIR: 'fixture-root', AI_WORKSPACE_ROOT: 'fixture-models', TOKEN: 'private', helper: () => undefined };
  const first = client.interrogateTag(Buffer.from('image'), { signal: controller.signal, config });
  const sent = instances[0].messages[0] as { options: { config: unknown; signal?: AbortSignal } };
  assert.deepEqual(sent.options.config, { ROOT_DIR: config.ROOT_DIR, AI_WORKSPACE_ROOT: config.AI_WORKSPACE_ROOT });
  assert.equal(sent.options.signal, undefined);
  await assert.rejects(client.interrogateTag(Buffer.from('second')), { code: 'INTERROGATE_BUSY' });
  controller.abort();
  await assert.rejects(first, { name: 'AbortError' });
  assert.equal(instances[0].terminated, true);
  instances[0].emit('message', { result: { ok: false, reason: 'late' } });
  await assert.rejects(client.interrogateTag(Buffer.from('third')), { code: 'INTERROGATE_BUSY' });
  assert.equal(instances.length, 1);
  instances[0].emit('exit', 0);
  const second = client.interrogateTag(Buffer.from('next'), { timeoutMs: 10 });
  await assert.rejects(second, { code: 'INTERROGATE_TIMEOUT' });
  await assert.rejects(client.interrogateTag(Buffer.from('blocked')), { code: 'INTERROGATE_BUSY' });
  instances[1].emit('exit', 0);
  const third = client.interrogateTag(Buffer.from('success'));
  instances[2].emit('message', { result: { ok: false, reason: 'fixture' } });
  assert.deepEqual(await third, { ok: false, reason: 'fixture' });
  const fourth = client.interrogateTag(Buffer.from('reuse'));
  assert.equal(instances.length, 3, 'successful requests reuse one worker/session');
  const shutdown = client.close();
  await assert.rejects(fourth, { code: 'INTERROGATE_CLOSED' });
  await shutdown;
  await assert.rejects(client.interrogateTag(Buffer.from('closed')), { code: 'INTERROGATE_CLOSED' });
  const reopened = createInterrogateClient();
  const next = reopened.interrogateTag(Buffer.from('new-owner'));
  instances[3].emit('message', { result: { ok: false, reason: 'new-owner' } });
  assert.deepEqual(await next, { ok: false, reason: 'new-owner' });
  await reopened.close();
  delete require.cache[clientPath];
});

test('WD14 real worker returns the isolated missing-model result and closes', async () => {
  const clientPath = require.resolve('../../server/interrogate-client');
  delete require.cache[clientPath];
  const { createInterrogateClient }: typeof import('../../server/interrogate-client') = require(clientPath);
  const client = createInterrogateClient();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huiyu-wd14-worker-'));
  const previous = process.env.AICS_WD14_MODEL_DIR;
  delete process.env.AICS_WD14_MODEL_DIR;
  try {
    const result = await client.interrogateTag(Buffer.from('fixture'), { config: { ROOT_DIR: root, AI_WORKSPACE_ROOT: root } });
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.reason);
  } finally {
    await client.close();
    if (previous === undefined) delete process.env.AICS_WD14_MODEL_DIR;
    else process.env.AICS_WD14_MODEL_DIR = previous;
    fs.rmdirSync(root);
    delete require.cache[clientPath];
  }
});

test('gateway closes other owners while WD14 drains and never starts fallback after shutdown', async t => {
  const clients: typeof import('../../server/interrogate-client') = require('../../server/interrogate-client');
  let rejectRequest: ((error: Error) => void) | undefined;
  let started!: () => void, release!: () => void, otherClosed!: () => void;
  const admitted = new Promise<void>(resolve => { started = resolve; });
  const nativeExit = new Promise<void>(resolve => { release = resolve; });
  const otherOwnerClosed = new Promise<void>(resolve => { otherClosed = resolve; });
  t.mock.method(clients, 'createInterrogateClient', () => ({
    interrogateTag: () => new Promise<import('../../server/interrogate-types').InterrogateResult>((_resolve, reject) => { rejectRequest = reject; started(); }),
    probe: () => ({ available: false, reason: 'fixture' }),
    close: () => {
      rejectRequest?.(Object.assign(new Error('fixture closed'), { code: 'INTERROGATE_CLOSED', status: 503 }));
      return nativeExit;
    },
  }));
  const fixture: typeof import('./gateway-test-stack') = require('./gateway-test-stack');
  const stack = await fixture.start({ workspace: { close: async () => { otherClosed(); } } });
  let upstreamCalls = 0;
  // Startup health probes are independent; count only dispatched inference.
  stack.upstreams.sd.mock.server.on('request', req => { if (req.method === 'POST') upstreamCalls++; });
  stack.upstreams.comfy.mock.server.on('request', req => { if (req.method === 'POST') upstreamCalls++; });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('shutdown ordering fixture timed out')), 3000); });
  try {
    const request = fetch(stack.baseUrl + '/api/interrogate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'tag', image: 'aGVsbG8='.padEnd(2048, 'A') }),
    });
    await Promise.race([admitted, deadline]);
    assert.ok(stack.gateway);
    const shutdown = stack.gateway.close();
    let completed = false;
    void Promise.resolve(shutdown).then(() => { completed = true; });
    await Promise.race([otherOwnerClosed, deadline]);
    assert.equal(completed, false, 'other owners must close before native inference exits');
    const response = await Promise.race([request, deadline]);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'INTERROGATE_CLOSED');
    assert.equal(upstreamCalls, 0, 'shutdown must not dispatch WebUI or ComfyUI fallback');
    release();
    await shutdown;
  } finally {
    clearTimeout(timeout);
    release();
    await stack.close();
  }
});
