'use strict';

const { test }: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs: typeof import('node:fs') = require('node:fs');
const os: typeof import('node:os') = require('node:os');
const path: typeof import('node:path') = require('node:path');
const bench: typeof import('./benchmark-anima-teacache') = require('./benchmark-anima-teacache');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

function fixture(t: import('node:test').TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huiyu-comfy-benchmark-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const graph = {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: 'fixture-no-real-model.safetensors', weight_dtype: 'default' } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: 'neutral fixture' } },
    '3': { class_type: 'AnimaTeaCache', inputs: { model: ['1', 0], rel_l1_thresh: .05 } },
    '4': { class_type: 'KSampler', inputs: { model: ['3', 0], positive: ['2', 0], negative: ['2', 0], seed: 100, steps: 3, cfg: 4, sampler_name: 'euler', scheduler: 'simple' } },
    '5': { class_type: 'SaveImage', inputs: { images: ['4', 0], filename_prefix: 'never-overwrite-source' } },
  };
  const workflow = path.join(root, 'workflow.json'), output = path.join(root, 'results');
  fs.writeFileSync(workflow, JSON.stringify(graph));
  return { root, workflow, output, graph, args: ['--workflow', workflow, '--output-dir', output, '--sampler-node', '4', '--teacache-node', '3', '--repeats', '2'] };
}
function history(id: string, cached: string[] = ['1', '2'], status = 'success') {
  return { [id]: { prompt: [0, id], outputs: { '5': { images: [{ filename: 'fixture.png', subfolder: '', type: 'output' }] } },
    status: { completed: true, status_str: status, messages: [
      ['execution_start', { prompt_id: id, timestamp: 1000 }], ['execution_cached', { prompt_id: id, nodes: cached }],
      ['execution_success', { prompt_id: id, timestamp: 2500 }],
    ] } } };
}

function mockApi(t: import('node:test').TestContext, mode = 'success') {
  const requests: { url: string; init?: RequestInit }[] = [], prompts: any[] = [];
  let count = 0;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); requests.push({ url, init });
    const route = new URL(url).pathname;
    let value: any;
    if (route === '/system_stats') value = { devices: [{ name: 'FAKE TEST DEVICE' }], system: { comfyui_version: 'fixture' } };
    else if (route === '/queue') value = { queue_running: mode === 'busy' ? [[99, 'other-job']] : [], queue_pending: [] };
    else if (route === '/prompt') {
      prompts.push(JSON.parse(String(init?.body))); count++;
      if (mode === 'uncertain') throw Error('fixture lost response after submission');
      value = { prompt_id: 'fixture-' + count, node_errors: {} };
    } else if (route.startsWith('/history/')) value = history('fixture-' + count, mode === 'cached' ? ['4'] : ['1', '2'], mode === 'failed' ? 'error' : 'success');
    else if (route === '/view') return new Response(new Uint8Array(PNG), { headers: { 'content-type': 'image/png' } });
    else throw Error('Unexpected fixture route: ' + route);
    return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  });
  t.mock.method(console, 'log', () => {});
  return { requests, prompts };
}

test('default plan has no network or writes and pairs fresh seeds in AB/BA order', async t => {
  const f = fixture(t), before = fs.readFileSync(f.workflow);
  t.mock.method(globalThis, 'fetch', () => { throw Error('network forbidden during plan'); });
  t.mock.method(console, 'log', () => {});
  const plan: any = await bench.main(f.args);
  assert.equal(plan.mode, 'plan'); assert.equal(plan.nativeSigmaParity, 'not-established');
  assert.equal(fs.existsSync(f.output), false); assert.deepEqual(fs.readFileSync(f.workflow), before);
  assert.deepEqual(plan.runs.map((run: any) => [run.phase, run.variant, run.seed]), [
    ['warmup', 'baseline', 100], ['warmup', 'cached', 101],
    ['measured', 'baseline', 102], ['measured', 'cached', 102], ['measured', 'cached', 103], ['measured', 'baseline', 103],
  ]);
  const opts = bench.options(f.args), prepared = bench.prepare(opts);
  const baseline = bench.workflowFor(prepared.graph, opts, plan.runs[2], 'fixture');
  assert.deepEqual(baseline['4'].inputs.model, ['1', 0]); assert.equal(baseline['3'], undefined);
  assert.deepEqual(prepared.graph, f.graph, 'baseline construction must not mutate source/candidate');
  assert.throws(() => bench.options([...f.args, '--run', '--plan']), /Choose/);
  assert.throws(() => bench.options([...f.args, '--endpoint', 'https://example.com']), /loopback/);
});

test('history success requires identity, cache-miss sampler, output and terminal evidence', () => {
  assert.equal(bench.completed({}, 'job', '4', '5'), null);
  assert.equal(bench.completed(history('job'), 'job', '4', '5')?.graphSeconds, 1.5);
  assert.throws(() => bench.completed(history('job', ['4']), 'job', '4', '5'), /node cache/);
  assert.throws(() => bench.completed(history('job', [], 'error'), 'job', '4', '5'), /did not succeed/);
  const missing = history('job'); missing.job.status.messages.pop();
  assert.throws(() => bench.completed(missing, 'job', '4', '5'), /successful execution/);
  const other = history('job'); other.job.prompt[1] = 'wrong';
  assert.throws(() => bench.completed(other, 'job', '4', '5'), /identity/);
});

test('mock-only run retains warmups but excludes them from statistics and saves local HTML/images', async t => {
  const f = fixture(t), api = mockApi(t);
  const report: any = await bench.main([...f.args, '--run']);
  assert.equal(api.prompts.length, 6); assert.equal(report.runs.length, 6);
  assert.equal(report.summary.baseline.completionSeconds.count, 2);
  assert.equal(report.summary.cached.graphSeconds.median, 1.5);
  assert.equal(report.summary.baseline.completionSeconds.p95, null);
  assert.equal(report.peakVram, null); assert.equal(report.nativeSigmaParity, 'not-established');
  assert.equal('speedup' in report, false);
  assert.ok(report.runs.every((run: any) => run.deliveredSeconds >= run.completionSeconds && run.outputSha256.length === 64));
  assert.match(fs.readFileSync(path.join(f.output, 'review.html'), 'utf8'), /quality unreviewed/);
  for (const run of report.runs) assert.deepEqual(fs.readFileSync(path.join(f.output, run.image)), PNG);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.workflow, 'utf8')), f.graph);
  const posts = api.requests.filter(request => request.init?.method === 'POST');
  assert.ok(posts.every(request => new URL(request.url).pathname === '/prompt'), 'never flush or globally interrupt an existing server');
});

test('failure or sampler cache hits stop the suite rather than publishing speedup', async t => {
  for (const mode of ['failed', 'cached']) await t.test(mode, async child => {
    const f = fixture(child), api = mockApi(child, mode);
    await assert.rejects(bench.main([...f.args, '--run']), mode === 'failed' ? /did not succeed/ : /node cache/);
    assert.equal(api.prompts.length, 1); assert.equal(fs.existsSync(path.join(f.output, 'report.json')), false);
    const state = JSON.parse(fs.readFileSync(path.join(f.output, 'warmup-0-baseline/status.json'), 'utf8'));
    assert.equal(state.promptId, 'fixture-1'); assert.ok(state.failure);
  });
});

test('busy service never submits and uncertain submit is saved without retry', async t => {
  for (const mode of ['busy', 'uncertain']) await t.test(mode, async child => {
    const f = fixture(child), api = mockApi(child, mode);
    await assert.rejects(bench.main([...f.args, '--run']), mode === 'busy' ? /queue must be empty/ : /lost response/);
    assert.equal(api.prompts.length, mode === 'busy' ? 0 : 1);
    const state = JSON.parse(fs.readFileSync(path.join(f.output, 'warmup-0-baseline/status.json'), 'utf8'));
    assert.equal(state.status, mode === 'busy' ? 'preflight' : 'submission-unknown');
    assert.equal(fs.existsSync(path.join(f.output, 'report.json')), false);
  });
});

test('tail percentile is only emitted with enough samples', () => {
  assert.deepEqual(bench.statistics([4, 1, 2, 3]).median, 2.5);
  assert.equal(bench.statistics(Array.from({ length: 20 }, (_, i) => i + 1)).p95, 19);
});
