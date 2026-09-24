import assert = require('node:assert/strict');
import http = require('node:http');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import { test as nodeTest, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { requestJson, createWebUIProbe, createWebUIJob, startWebUIJob, publicJob } from '../../server/generation/webui';
import { createGenerationService, type GenerationDependencies } from '../../server/generation/service';
import { CHECKPOINT, MAX_UPSTREAM_JSON_BYTES, WEB_JOB_TTL_MS } from '../../server/generation/constants';
import type { GenerationConfig, GenerationInput } from '../../server/generation/types';

const test = (name: string, run: (context: TestContext) => Promise<void>) => nodeTest(name, { timeout:4000 }, run);
const IMAGE = Buffer.from('isolated-fixture-image').toString('base64');
const input = (): GenerationInput => ({
  prompt:'fixture landscape', negative:'', cleanPrompt:'fixture landscape', profile:'fixture', character:'',
  modelId:CHECKPOINT, loras:[], loraTags:[], width:832, height:1216, steps:20, cfg:5,
  sampler:'Euler', scheduler:'normal', seed:9, webuiScheduler:'', comfyUnsupported:false,
  hiresFix:false, hiresScale:1.5, hiresUpscaler:'Latent', hiresSteps:10, denoisingStrength:0.4,
  faceDetailer:false, autoHires:false, superResWanted:false, comfyHires:false,
});
function temporary(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huiyu-webui-lifecycle-'));
  t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
  return dir;
}
async function server(t: TestContext, handler: http.RequestListener): Promise<string> {
  const instance = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    instance.once('error', reject);
    instance.listen(0, '127.0.0.1', () => { instance.removeListener('error', reject); resolve(); });
  });
  t.after(() => new Promise<void>(resolve => {
    instance.closeAllConnections(); instance.close(() => resolve());
  }));
  const address = instance.address();
  assert.ok(address && typeof address !== 'string');
  return 'http://127.0.0.1:' + address.port;
}
async function until(check: () => boolean, message = 'condition did not settle'): Promise<void> {
  const deadline = Date.now() + 2500;
  while (!check()) {
    if (Date.now() >= deadline) assert.fail(message);
    await delay(5);
  }
}
function sendImage(response: http.ServerResponse, seed = 0): void {
  response.end(JSON.stringify({ images:[IMAGE], info:JSON.stringify({ seed }) }));
}
function catalog(request: http.IncomingMessage, response: http.ServerResponse): boolean {
  if (request.url === '/sdapi/v1/options') response.end(JSON.stringify({ sd_model_checkpoint:CHECKPOINT }));
  else if (request.url === '/sdapi/v1/sd-models') response.end(JSON.stringify([{ title:CHECKPOINT }]));
  else if (request.method === 'GET') response.end('[]');
  else return false;
  return true;
}
function fakeComfy(): NonNullable<GenerationDependencies['waiComfy']> {
  return { probe:async () => false, status:() => ({ pending:0 }), get:() => null, close:() => {},
    cancel:async () => {},
  } as unknown as NonNullable<GenerationDependencies['waiComfy']>;
}
function config(host: string, root: string): GenerationConfig {
  return { SD_HOST:host, COMFY_HOST:host, ROOT_DIR:root, RUNTIME_ROOT:root, AI_WORKSPACE_ROOT:root };
}

test('WebUI transport uses Basic auth and supports empty successful bodies', async t => {
  let received: string | undefined;
  const host = await server(t, (req, res) => {
    received = req.headers.authorization;
    res.writeHead(204); res.end();
  });
  assert.equal(await requestJson({ SD_HOST:host, SD_API_AUTH:'owner:secret' }, 'SD_HOST', 'POST', '/interrupt', {}, 1000), null);
  assert.equal(received, 'Basic ' + Buffer.from('owner:secret').toString('base64'));
});

test('WebUI preserves HTTP error details without confusing them with transport errors', async t => {
  const host = await server(t, (_req, res) => { res.writeHead(503); res.end('{"error":"fixture"}'); });
  await assert.rejects(requestJson({ SD_HOST:host }, 'SD_HOST', 'GET', '/', null, 1000), {
    code:'UPSTREAM_ERROR', status:502, detail:{ status:503, data:{ error:'fixture' } },
  });
});

test('WebUI invalid JSON and unsupported URLs have stable errors', async t => {
  const host = await server(t, (_req, res) => res.end('{bad'));
  await assert.rejects(requestJson({ SD_HOST:host }, 'SD_HOST', 'GET', '/', null, 1000), { code:'INVALID_UPSTREAM_RESPONSE' });
  for (const value of ['not a url', 'file:///tmp/not-an-upstream'])
    await assert.rejects(requestJson({ SD_HOST:value }, 'SD_HOST', 'GET', '/', null, 1000), { code:'UPSTREAM_CONFIG_INVALID' });
});

test('WebUI rejects oversized JSON with the size-limit code', async t => {
  const host = await server(t, (_req, res) => res.end('"' + 'x'.repeat(MAX_UPSTREAM_JSON_BYTES) + '"'));
  await assert.rejects(requestJson({ SD_HOST:host }, 'SD_HOST', 'GET', '/', null, 1000), { code:'UPSTREAM_RESPONSE_TOO_LARGE' });
});

test('WebUI settles a body truncated after headers', async t => {
  const host = await server(t, (_req, res) => {
    res.writeHead(200, { 'Content-Length':'1000' }); res.write('{');
    const timer = setTimeout(() => res.destroy(), 10); t.after(() => clearTimeout(timer));
  });
  await assert.rejects(requestJson({ SD_HOST:host }, 'SD_HOST', 'GET', '/', null, 1000), { code:'UPSTREAM_UNAVAILABLE' });
});

test('WebUI total deadline bounds a continuously dripping response', async t => {
  const host = await server(t, (_req, res) => {
    res.write('{');
    const drip = setInterval(() => res.write(' '), 10);
    const end = setTimeout(() => { clearInterval(drip); res.end('}'); }, 300);
    res.once('close', () => { clearInterval(drip); clearTimeout(end); });
  });
  await assert.rejects(requestJson({ SD_HOST:host }, 'SD_HOST', 'GET', '/', null, 80), { code:'UPSTREAM_TIMEOUT', status:504 });
});

test('WebUI pre-abort never sends a request', async t => {
  let calls = 0;
  const host = await server(t, (_req, res) => { calls++; res.end('{}'); });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(requestJson({ SD_HOST:host }, 'SD_HOST', 'GET', '/', null, 1000, controller.signal), { code:'ABORT_ERR' });
  assert.equal(calls, 0);
});

test('WebUI abort closes a response already streaming', async t => {
  let started = false;
  const host = await server(t, (_req, res) => { started = true; res.write('{'); });
  const controller = new AbortController();
  const work = requestJson({ SD_HOST:host }, 'SD_HOST', 'GET', '/', null, 1000, controller.signal);
  const rejected = assert.rejects(work, { code:'ABORT_ERR' });
  await until(() => started); controller.abort(); await rejected;
});

test('WebUI probe invalidates its cache when API authentication changes', async t => {
  const host = await server(t, (req, res) => {
    if (req.headers.authorization !== 'Basic ' + Buffer.from('new').toString('base64')) {
      res.writeHead(401); res.end('{}'); return;
    }
    catalog(req, res);
  });
  const settings = { SD_HOST:host, SD_API_AUTH:'old' };
  const probe = createWebUIProbe(settings);
  assert.equal((await probe()).online, false);
  settings.SD_API_AUTH = 'new';
  assert.equal((await probe()).waiAvailable, true);
});

test('WebUI captures input and connection; duplicate start publishes one actual seed', async t => {
  let calls = 0;
  const prompts: unknown[] = [];
  const host = await server(t, async (req, res) => {
    calls++;
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    prompts.push(body.prompt); sendImage(res, 0);
  });
  const settings = config(host, temporary(t));
  const source = input(); source.loras = [{ id:'fixture', file:'fixture.safetensors', strength:0 }];
  const job = createWebUIJob(settings, source, 'local', { start:false });
  source.prompt = 'mutated'; source.loras[0].strength = 1;
  settings.SD_HOST = 'http://127.0.0.1:1';
  await Promise.all([startWebUIJob(settings, job), startWebUIJob(settings, job)]);
  assert.equal(calls, 1); assert.deepEqual(prompts, ['fixture landscape']); assert.equal(job.status, 'succeeded');
  assert.equal(job.input.loras[0].strength, 0); assert.equal(job.metadata.loraStrength, 0);
  assert.equal(publicJob(job).seed, 0); assert.equal(publicJob(job).metadata.seed, 0);
});

test('WebUI never restarts terminal jobs or exposes invalid result encodings', async t => {
  let calls = 0;
  const host = await server(t, (_req, res) => { calls++; res.end('{"images":["%%%"]}'); });
  const settings = config(host, temporary(t));
  const cancelled = createWebUIJob(settings, input(), 'local', { start:false });
  cancelled.status = 'cancelled'; await startWebUIJob(settings, cancelled); assert.equal(calls, 0);
  const invalid = createWebUIJob(settings, input(), 'local', { start:false });
  await startWebUIJob(settings, invalid);
  assert.equal(invalid.status, 'failed'); assert.equal(invalid.code, 'SD_INVALID_IMAGE');
  assert.equal(publicJob(invalid).resultAvailable, false);
});

test('cancelling succeeded or failed WebUI jobs is an idempotent no-op', async t => {
  let interrupts = 0, renders = 0;
  const host = await server(t, (req, res) => {
    if (catalog(req, res)) return;
    if (req.url?.endsWith('/interrupt')) { interrupts++; res.end('{}'); return; }
    renders++; if (renders === 1) sendImage(res); else res.end('{"images":[]}');
  });
  const service = createGenerationService(config(host, temporary(t)), { waiComfy:fakeComfy() });
  t.after(() => service.close());
  for (const expected of ['succeeded', 'failed']) {
    const created = await service.submit(input(), 'local');
    await until(() => service.getJob(created.id, 'local').status === expected);
    const before = service.getJob(created.id, 'local');
    assert.deepEqual(await service.cancel(created.id, 'local'), before);
    assert.deepEqual(await service.cancel(created.id, 'local'), before);
    if (expected === 'succeeded') assert.equal(service.getResult(created.id, 'local').kind, 'buffer');
  }
  assert.equal(interrupts, 0);
});

test('duplicate cancellations share an interrupt and fence the next queued job', async t => {
  const renders: http.ServerResponse[] = [], interrupts: http.ServerResponse[] = [];
  const host = await server(t, (req, res) => {
    if (catalog(req, res)) return;
    (req.url?.endsWith('/interrupt') ? interrupts : renders).push(res);
  });
  const service = createGenerationService(config(host, temporary(t)), { waiComfy:fakeComfy() });
  t.after(() => service.close());
  const first = await service.submit(input(), 'local');
  await until(() => renders.length === 1);
  const second = await service.submit(input(), 'local');
  await assert.rejects(service.cancel(first.id, 'other'), { code:'JOB_NOT_FOUND' });
  const cancellations = [service.cancel(first.id, 'local'), service.cancel(first.id, 'local')];
  await until(() => interrupts.length > 0); sendImage(renders[0]);
  await delay(30);
  assert.equal(renders.length, 1, 'next render must wait for the previous interrupt');
  assert.equal(interrupts.length, 1, 'double clicks must not send duplicate global interrupts');
  interrupts[0].end('{}'); await Promise.all(cancellations);
  await until(() => renders.length === 2); sendImage(renders[1]);
  await until(() => service.getJob(second.id, 'local').status === 'succeeded');
  assert.equal(service.getJob(first.id, 'local').status, 'cancelled');
  assert.throws(() => service.getResult(first.id, 'local'), { code:'RESULT_NOT_FOUND' });
});

test('failed cancellation is explicit and holds admission until execution settles', async t => {
  const renders: http.ServerResponse[] = [];
  const host = await server(t, (req, res) => {
    if (catalog(req, res)) return;
    if (req.url?.endsWith('/interrupt')) { res.writeHead(503); res.end('{}'); return; }
    renders.push(res);
  });
  const service = createGenerationService(config(host, temporary(t)), { waiComfy:fakeComfy() });
  t.after(() => service.close());
  const first = await service.submit(input(), 'local'); await until(() => renders.length === 1);
  await service.submit(input(), 'local');
  const cancelled = await service.cancel(first.id, 'local');
  assert.equal(cancelled.status, 'cancelling'); assert.equal(cancelled.code, 'WEBUI_CANCEL_FAILED');
  assert.equal((await service.getStatus()).pending, 2); assert.equal(renders.length, 1);
  sendImage(renders[0]); await until(() => renders.length === 2); sendImage(renders[1]);
  await until(() => service.getJob(first.id, 'local').status === 'failed');
});

test('queued cancellation never submits to WebUI', async t => {
  const renders: http.ServerResponse[] = [];
  const host = await server(t, (req, res) => { if (!catalog(req, res)) renders.push(res); });
  const service = createGenerationService(config(host, temporary(t)), { waiComfy:fakeComfy() });
  t.after(() => service.close());
  await service.submit(input(), 'local'); await until(() => renders.length === 1);
  const queued = await service.submit(input(), 'local');
  assert.equal((await service.cancel(queued.id, 'local')).status, 'cancelled');
  sendImage(renders[0]); await delay(30);
  assert.equal(renders.length, 1); assert.equal(service.getJob(queued.id, 'local').status, 'cancelled');
});

test('WebUI close aborts in-flight transport and cannot resurrect jobs', async t => {
  let started = false, disconnected = false, closed = 0;
  const host = await server(t, (req, res) => {
    if (catalog(req, res)) return;
    started = true; res.once('close', () => { disconnected = true; });
  });
  const provider = fakeComfy(); provider.close = () => { closed++; };
  const service = createGenerationService(config(host, temporary(t)), { waiComfy:provider });
  t.after(() => service.close());
  const job = await service.submit(input(), 'local'); await until(() => started);
  service.close(); service.close();
  await until(() => disconnected, 'closing the service must close its HTTP request');
  await assert.rejects(service.submit(input(), 'local'), { code:'GENERATION_CLOSED' });
  assert.throws(() => service.getJob(job.id, 'local'), { code:'JOB_NOT_FOUND' }); assert.equal(closed, 1);
});

test('WebUI retention timer starts at settlement rather than admission', async t => {
  let response: http.ServerResponse | undefined;
  const host = await server(t, (req, res) => { if (!catalog(req, res)) response = res; });
  const timers = t.mock.method(globalThis, 'setTimeout');
  const retained = () => timers.mock.calls.filter(call => call.arguments[1] === WEB_JOB_TTL_MS).length;
  const service = createGenerationService(config(host, temporary(t)), { waiComfy:fakeComfy() });
  t.after(() => service.close());
  const job = await service.submit(input(), 'local'); await until(() => Boolean(response));
  assert.equal(retained(), 0, 'pending work has a separate transport deadline');
  sendImage(response!); await until(() => service.getJob(job.id, 'local').status === 'succeeded');
  await until(() => retained() === 1);
});

test('an in-flight Comfy acceptance after close is not acknowledged or watched', async t => {
  const root = temporary(t);
  const models = path.join(root, 'ComfyUI', 'models', 'checkpoints'); fs.mkdirSync(models, { recursive:true });
  fs.writeFileSync(path.join(models, CHECKPOINT), 'fixture-not-a-model');
  const host = await server(t, (_req, res) => res.end('{}'));
  let release: (() => void) | undefined, cancelled = 0;
  const provider = fakeComfy(); provider.probe = async () => true;
  provider.create = ((value: GenerationInput, owner: string) => ({ id:'late', status:'queued', input:value, owner })) as typeof provider.create;
  provider.submit = async job => { await new Promise<void>(resolve => { release = resolve; }); job.upstreamId = 'upstream-late'; };
  provider.cancel = async job => { cancelled++; return job; };
  const intervals = t.mock.method(globalThis, 'setInterval');
  const service = createGenerationService(config(host, root), { waiComfy:provider });
  t.after(() => service.close());
  const submitted = service.submit(input(), 'local');
  const rejected = assert.rejects(submitted, { code:'GENERATION_CLOSED' });
  await until(() => Boolean(release)); service.close(); release!(); await rejected;
  assert.equal(intervals.mock.calls.length, 0); assert.equal(cancelled, 1);
});
