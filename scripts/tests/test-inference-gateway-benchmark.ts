'use strict';

const { test }: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs: typeof import('node:fs') = require('node:fs');
const os: typeof import('node:os') = require('node:os');
const path: typeof import('node:path') = require('node:path');
const bench: typeof import('./benchmark-inference-gateway') = require('./benchmark-inference-gateway');
const { png }: typeof import('./generation-safety-fixture') = require('./generation-safety-fixture');

function fixture(t: import('node:test').TestContext, provider = 'native') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huiyu-gateway-benchmark-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const payload = { prompt: 'neutral protocol fixture, no real model', modelId: 'fixture-only', seed: 100,
    width: 832, height: 1216, steps: 2, cfg: 4, teaCache: true, initImage: 'already-uploaded-fixture.png' };
  const source = path.join(root, 'payload.json'), output = path.join(root, 'results');
  fs.writeFileSync(source, JSON.stringify(payload));
  t.mock.method(console, 'log', () => {});
  return { root, source, output, payload,
    args: ['--payload', source, '--expect-provider', provider, '--output-dir', output, '--repeats', '2'] };
}

function mockApi(t: import('node:test').TestContext, mode = 'success', provider = 'native') {
  const requests: { url: string; init?: RequestInit }[] = [], payloads: any[] = [];
  let count = 0;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); requests.push({ url, init });
    const route = new URL(url).pathname;
    let value: any;
    if (route === '/api/inference/settings') {
      if (mode === 'settings-unavailable') return new Response('not found', { status: 404 });
      value = { ok: true, active: { engine: mode === 'wrong-active' ? 'comfy' : provider }, configured: { engine: provider }, restartRequired: mode === 'wrong-active' };
    } else if (route === '/api/anima/status') value = { ok: true, pending: mode === 'busy' ? 1 : 0 };
    else if (route === '/api/anima/jobs') {
      payloads.push(JSON.parse(String(init?.body))); count++;
      if (mode === 'uncertain') throw Error('fixture lost response after submit');
      value = { ok: true, job: { id: 'fixture-' + (mode === 'reused-id' ? 1 : count), status: 'queued' } };
    } else if (route.endsWith('/result')) {
      return new Response(new Uint8Array(png(mode === 'reused-image' ? 80 : count)), { headers: { 'content-type': 'image/png' } });
    } else if (route.startsWith('/api/anima/jobs/')) value = { ok: true, job: {
      id: 'fixture-' + count, status: mode === 'failed' ? 'failed' : 'succeeded',
      provider: mode === 'wrong-provider' ? 'comfy' : provider,
      metadata: mode === 'missing-seed' ? {} : { seed: mode === 'wrong-seed' ? 100 : payloads.at(-1).seed,
        ...(mode === 'missing-prompt' ? {} : { prompt: mode === 'wrong-prompt' ? 'unrelated server text' : payloads.at(-1).prompt.trim() }),
        steps: 2, cfg: 4, sampler: 'euler', scheduler: 'simple', teaCache: true, teaCacheThresh: 0.08, hiresFix: false },
      code: mode === 'failed' ? 'FIXTURE_MODEL_FAILURE' : null,
      error: mode === 'failed' ? 'Fixture model failed before output' : null,
      resultUrl: '/api/anima/jobs/fixture-' + count + '/result',
    } };
    else throw Error('Unexpected fixture route: ' + route);
    return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  });
  return { requests, payloads };
}

test('product benchmark plan has no network/writes and only varies explicit seeds', async t => {
  const f = fixture(t), before = fs.readFileSync(f.source);
  t.mock.method(globalThis, 'fetch', () => { throw Error('network forbidden'); });
  const plan: any = await bench.main(f.args);
  assert.equal(plan.mode, 'plan'); assert.equal(plan.configurationEvidence, 'not-read-in-plan');
  assert.deepEqual(plan.runs.map((run: any) => [run.phase, run.requestedSeed]), [['warmup', 100], ['measured', 101], ['measured', 102]]);
  assert.equal(fs.existsSync(f.output), false); assert.deepEqual(fs.readFileSync(f.source), before);
  assert.throws(() => bench.options([...f.args, '--gateway', 'http://example.com']), /loopback/);
  assert.throws(() => bench.options([...f.args, '--plan', '--run']), /Choose/);
  fs.writeFileSync(f.source, JSON.stringify({ ...f.payload, seed: -1 }));
  assert.throws(() => bench.prepare(bench.options(f.args)), /seed/);
  fs.writeFileSync(f.source, JSON.stringify({ ...f.payload, sampler: 'euler' }));
  assert.throws(() => bench.prepare(bench.options(f.args)), /sampler.*provider\/catalog/);
  fs.writeFileSync(f.source, JSON.stringify({ ...f.payload, scheduler: 'simple' }));
  assert.throws(() => bench.prepare(bench.options(f.args)), /scheduler.*provider\/catalog/);
});

test('mock gateway runs both providers with product caches intact, warmups excluded and PNG/HTML evidence', async t => {
  for (const provider of ['native', 'comfy']) await t.test(provider, async child => {
    const f = fixture(child, provider), api = mockApi(child, provider === 'comfy' ? 'settings-unavailable' : 'success', provider);
    const report: any = await bench.main([...f.args, '--run']);
    assert.equal(report.status, 'measured-quality-unreviewed'); assert.equal(report.summary.wallSeconds.count, 2);
    assert.equal(report.summary.wallSeconds.p95, null); assert.equal(report.runs.length, 3);
    assert.equal(report.scheduleEvidence, 'unverified'); assert.equal(report.precisionParity, 'unverified');
    assert.equal(report.promptPopulation, 'repeated-prompt');
    assert.equal('speedup' in report, false); assert.equal(report.peakVram, null);
    assert.equal(report.runs[0].preflight.engineEvidence, provider === 'native' ? 'active-settings-match' : 'unverified-until-job-completion');
    assert.equal(report.summary.preflight.engineUnverifiedRuns, provider === 'native' ? 0 : 3);
    assert.deepEqual(api.payloads, [100, 101, 102].map(seed => ({ ...f.payload, seed })));
    for (const [index, run] of report.runs.entries()) {
      assert.equal(run.provider, provider); assert.equal(run.actualSeed, 100 + index);
      assert.deepEqual(run.serverMetadata, { seed: 100 + index, prompt: f.payload.prompt, steps: 2, cfg: 4, sampler: 'euler', scheduler: 'simple',
        teaCache: true, teaCacheThresh: 0.08, hiresFix: false });
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.output, path.dirname(run.image), 'status.json'), 'utf8')).serverMetadata, run.serverMetadata);
      assert.equal(run.width, 1); assert.equal(run.height, 1); assert.ok(run.wallSeconds > 0);
      assert.equal(run.requestSha256.length, 64); assert.equal(run.outputSha256.length, 64);
      assert.deepEqual(fs.readFileSync(path.join(f.output, run.image)), png(index + 1));
    }
    const review = fs.readFileSync(path.join(f.output, 'review.html'), 'utf8');
    assert.match(review, /quality unreviewed/);
    assert.match(review, /&quot;teaCacheThresh&quot;: 0.08/);
    assert.ok(api.requests.every(request => request.init?.cache === 'no-store'));
    assert.ok(api.requests.filter(request => request.init?.method === 'POST').every(request => new URL(request.url).pathname === '/api/anima/jobs'));
    assert.deepEqual(JSON.parse(fs.readFileSync(f.source, 'utf8')), f.payload);
  });
});

test('explicit positive prompts share exact planned/submitted requests without changing other payload fields', async t => {
  const f = fixture(t), api = mockApi(t), file = path.join(f.root, 'prompts.json');
  const payload = { ...f.payload, negative: 'fixed negative fixture text' };
  fs.writeFileSync(f.source, JSON.stringify(payload));
  const variants = { warmup: ['warm fixture', 'warm fixture'], measured: [' first measured fixture ', 'second measured fixture'] };
  fs.writeFileSync(file, JSON.stringify(variants));
  const original = fs.readFileSync(file), args = [...f.args, '--warmups', '2', '--prompt-variants', file];
  const plan: any = await bench.main(args);
  const requests = [...variants.warmup, ...variants.measured].map((prompt, i) => ({ ...payload, prompt, seed: 100 + i }));
  assert.equal(api.requests.length, 0); assert.equal(fs.existsSync(f.output), false);
  assert.deepEqual(plan.runs.map((run: any) => run.request), requests);
  assert.deepEqual(plan.runs.map((run: any) => run.expectedNormalizedPrompt), requests.map(request => request.prompt.trim()));
  const report: any = await bench.main([...args, '--run']);
  assert.deepEqual(api.payloads, requests); assert.equal(report.summary.wallSeconds.count, 2);
  assert.equal(report.promptPopulation, 'requested-distinct-prompts-within-suite');
  assert.equal(report.sourcePromptVariantsSha256.length, 64);
  assert.deepEqual(report.runs.map((run: any) => run.payload), requests);
  assert.deepEqual(fs.readFileSync(file), original); assert.deepEqual(JSON.parse(fs.readFileSync(f.source, 'utf8')), payload);
});

test('prompt variants reject mismatched counts, non-text, normalized duplicates and oversized input before submissions', t => {
  const f = fixture(t), file = path.join(f.root, 'prompts.json'), args = [...f.args, '--prompt-variants', file];
  t.mock.method(globalThis, 'fetch', () => { throw Error('network forbidden'); });
  for (const [variants, expected] of [
    [{ warmup: ['warm'], measured: ['one'] }, /matching/],
    [{ warmup: ['warm'], measured: ['one', 'two'], negative: 'forbidden override' }, /only warmup/],
    [{ warmup: ['warm'], measured: [' ', 'two'] }, /nonempty/],
    [{ warmup: ['warm'], measured: [1, 'two'] }, /nonempty/],
    [{ warmup: ['warm'], measured: ['\u0085warm\u0085', 'two'] }, /distinct/],
    [{ warmup: ['warm'], measured: ['one', ' one '] }, /distinct/],
    [{ warmup: ['warm'], measured: ['x'.repeat(12001), 'two'] }, /12000/],
  ] as const) {
    fs.writeFileSync(file, JSON.stringify(variants));
    assert.throws(() => bench.prepare(bench.options(args)), expected);
  }
  fs.writeFileSync(file, ' '.repeat(65537));
  assert.throws(() => bench.prepare(bench.options(args)), /variants exceed 64 KiB/);
  fs.writeFileSync(file, JSON.stringify({ warmup: ['warm'], measured: ['文'.repeat(12000), 'two'] }));
  fs.writeFileSync(f.source, JSON.stringify({ ...f.payload, negative: '文'.repeat(8000), maskPrompt: '文'.repeat(4000) }));
  assert.throws(() => bench.prepare(bench.options(args)), /planned request exceeds.*64 KiB/);
  assert.equal(fs.existsSync(f.output), false);
});

test('prompt variants require independently reported normalized server text', async t => {
  for (const mode of ['missing-prompt', 'wrong-prompt']) await t.test(mode, async child => {
    const f = fixture(child), api = mockApi(child, mode), file = path.join(f.root, 'prompts.json');
    fs.writeFileSync(file, JSON.stringify({ warmup: ['warm'], measured: ['one', 'two'] }));
    await assert.rejects(bench.main([...f.args, '--prompt-variants', file, '--run']), /Server-reported prompt.*unverified/);
    assert.equal(api.payloads.length, 1); assert.equal(fs.existsSync(path.join(f.output, 'report.json')), false);
  });
});

test('active/configured confusion and a busy gateway stop before any job submission', async t => {
  for (const mode of ['wrong-active', 'busy']) await t.test(mode, async child => {
    const f = fixture(child), api = mockApi(child, mode);
    await assert.rejects(bench.main([...f.args, '--run']), mode === 'wrong-active' ? /Active engine/ : /pending jobs/);
    assert.equal(api.payloads.length, 0); assert.equal(fs.existsSync(path.join(f.output, 'report.json')), false);
    assert.ok(fs.existsSync(path.join(f.output, 'warmup-0/preflight.json')));
  });
});

test('uncertain/failed jobs and mismatched evidence never retry or publish a successful report', async t => {
  const modes = { uncertain: /lost response/, failed: /job failed/, 'wrong-provider': /Completed provider/,
    'missing-seed': /Server-reported seed/, 'wrong-seed': /Server-reported seed/,
    'reused-id': /reused a job ID/, 'reused-image': /Identical image bytes/ };
  for (const [mode, message] of Object.entries(modes)) await t.test(mode, async child => {
    const f = fixture(child), api = mockApi(child, mode);
    await assert.rejects(bench.main([...f.args, '--run']), message);
    const second = ['wrong-seed', 'reused-id', 'reused-image'].includes(mode);
    assert.equal(api.payloads.length, second ? 2 : 1); assert.equal(fs.existsSync(path.join(f.output, 'report.json')), false);
    const state = JSON.parse(fs.readFileSync(path.join(f.output, second ? 'measured-0/status.json' : 'warmup-0/status.json'), 'utf8'));
    assert.ok(state.failure); assert.equal(state.status, mode === 'uncertain' ? 'submission-unknown' : 'stopped');
    if (mode === 'failed') {
      assert.equal(state.serverCode, 'FIXTURE_MODEL_FAILURE');
      assert.equal(state.serverError, 'Fixture model failed before output');
      assert.equal(state.serverMetadata.seed, 100);
    }
    if (mode === 'missing-seed') assert.equal(state.actualSeed, undefined, 'requested seed must not masquerade as server evidence');
  });
});
