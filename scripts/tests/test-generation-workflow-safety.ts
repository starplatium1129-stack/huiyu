'use strict';

const { test }: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const { spawn, spawnSync }: typeof import('node:child_process') = require('node:child_process');
const F: typeof import('./generation-safety-fixture') = require('./generation-safety-fixture');
const { gatewayUrl, validatePng }: typeof import('../lib/generation-gateway') = require('../lib/generation-gateway');
const { buildReview }: typeof import('../maintenance/build-scene-manual-review') = require('../maintenance/build-scene-manual-review');
const { planPublished, assertFullReviewCoverage }: typeof import('../maintenance/publish-scene-showcase-anima11') = require('../maintenance/publish-scene-showcase-anima11');
const scenePublisher: typeof import('../maintenance/publish-scene-showcase-anima11') = require('../maintenance/publish-scene-showcase-anima11');
const popularPublisher: typeof import('../maintenance/publish-popular-showcase') = require('../maintenance/publish-popular-showcase');

const modules = F.entries.map(name => require(`../maintenance/${name}`));
const records = (f: any) => JSON.parse(fs.readFileSync(path.join(f.output, 'generation-manifest.json'), 'utf8'));
async function run(index: any, f: any, mock: any, args: any = [], deps: any = {}) {
  return (await F.guarded(f, () => modules[index].main([...f.args, '--gateway', mock.origin, ...args],
    { env: f.env, fetchImpl: mock.fetchImpl, pollMs: 1, timeoutMs: 250, ...deps }))).result;
}

// Child probe forbids writes, model/compiler loading, network and process spawning on import/help/plan.
const probe = String.raw`
  const fs = require('node:fs'), Module = require('node:module');
  const fail = name => () => { throw Error('PROBE forbidden: ' + name); };
  for (const name of ['writeFileSync','appendFileSync','mkdirSync','renameSync','unlinkSync','rmSync','rmdirSync','copyFileSync','cpSync','createWriteStream']) fs[name] = fail(name);
  const read = fs.readFileSync;
  fs.readFileSync = function(file, ...args) {
    if (/[\\/](data|assets|runtime)[\\/]|no-target-reads/.test(String(file))) throw Error('PROBE data read: ' + file);
    return read.call(this, file, ...args);
  };
  for (const name of ['statSync','lstatSync','readdirSync','existsSync','realpathSync']) {
    const original = fs[name];
    fs[name] = (...args) => { if (String(args[0]).includes('no-target-reads')) throw Error('PROBE target read'); return original(...args); };
  }
  global.fetch = fail('fetch');
  for (const name of ['node:http','node:https']) { const h = require(name); h.request = fail('http'); h.get = fail('http'); }
  for (const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) require('node:child_process')[name] = fail('spawn');
  const load = Module._load;
  Module._load = function(name, ...args) {
    if (/popularContent|promptPolicy|server[\\/]config/.test(name)) throw Error('PROBE eager compiler/config import');
    return load.call(this, name, ...args);
  };
  const before = process.eventNames().map(n => [n, process.listenerCount(n)]);
  const entry = require(process.env.PROBE_ENTRY);
  if (process.env.PROBE_MODE === 'import') {
    if (JSON.stringify(before) !== JSON.stringify(process.eventNames().map(n => [n, process.listenerCount(n)]))) throw Error('PROBE import listener effect');
  } else entry.main([process.env.PROBE_MODE, '--root', 'no-target-reads', '--gateway', 'invalid']).catch(e => { console.error(e); process.exitCode = 1; });
`;

for (const [index, name] of F.entries.entries()) {
  test(`${name}: import, help and plan perform no target IO or network`, () => {
    for (const mode of ['import', '--help', '--plan']) {
      const child = spawnSync(process.execPath, ['-e', probe], { cwd: F.CODE_ROOT, encoding: 'utf8', timeout: 10000,
        env: { ...process.env, PROBE_ENTRY: path.join(F.CODE_ROOT, 'scripts/maintenance', name), PROBE_MODE: mode } });
      assert.equal(child.status, 0, `${mode}: ${child.stderr}`);
    }
  });

  test(`${name}: real fixture dry-run compiles without writes or model requests`, async t => {
    const f = F.fixture(t), before = F.tree(f.temporary);
    let requests = 0;
    const { result, writes } = await F.guarded(f, () => modules[index].main([...f.args, '--dry-run'], {
      env: f.env, fetchImpl: () => { requests++; throw Error('model forbidden'); },
    }), { preview: true });
    assert.equal(result.mode, 'preview');
    assert.equal(result.count, index === 1 ? 2 : 1, 'must exercise actual compiled tasks, not an empty fixture');
    assert.equal(result.gateway, 'http://127.0.0.1:3000');
    assert.equal(writes.length, 0); assert.equal(requests, 0);
    assert.deepEqual(F.tree(f.temporary), before);
    assert.ok(result.tasks.every((r: any) => r.inputVersion.length === 64 && r.payload.prompt));
  });

  test(`${name}: mock generation is pending, input-bound, immutable and resumable`, async t => {
    const f = F.fixture(t), mock = await F.mockGateway(t);
    const sourceBefore = F.tree(f.root), activeBefore = F.tree(path.dirname(f.manifest));
    const result = await run(index, f, mock);
    assert.equal(result.exitCode, 0);
    const first = records(f), expected = index === 1 ? 2 : 1;
    assert.equal(first.length, expected); assert.equal(mock.state.posts.length, expected);
    for (const record of first) {
      assert.equal(record.status, 'succeeded'); assert.equal(record.review.verdict, 'pending');
      assert.equal(record.review.recordId, record.recordId); assert.equal(record.publishedAt, undefined);
      assert.equal(record.review.reviewedAt, undefined); assert.equal(record.actualSeed, 123);
      assert.ok(record.createdAt && record.updatedAt && record.generatedAt && record.jobId);
      assert.equal(record.gateway, mock.origin); assert.equal(record.inputVersion.length, 64);
      assert.ok(record.sources.every((s: any) => s.sha256.length === 64 && s.bytes > 0));
      assert.equal(record.asset.sha256, F.sha(fs.readFileSync(path.join(f.output, record.image))));
      assert.deepEqual(record.payload, mock.state.posts[first.indexOf(record)]);
      assert.equal(record.payloadSha256, F.sha(JSON.stringify(record.payload)));
    }
    const reviewFile = path.join(f.output, 'manual-review.json');
    F.writeJson(reviewFile, { human: 'sentinel; do not alter' });
    const reviewHash = F.sha(fs.readFileSync(reviewFile));
    const calls = mock.state.gets.length;
    const repeated = await run(index, f, mock);
    assert.equal(repeated.reused, expected); assert.equal(mock.state.posts.length, expected);
    assert.equal(mock.state.gets.length, calls); assert.deepEqual(records(f), first);
    assert.equal(F.sha(fs.readFileSync(reviewFile)), reviewHash);
    assert.deepEqual(F.tree(f.root), sourceBefore); assert.deepEqual(F.tree(path.dirname(f.manifest)), activeBefore);
    assert.equal(fs.existsSync(path.join(f.output, 'manifest.json')), false);
    assert.deepEqual(buildReview(first, {}).pending.sort(), first.map((r: any) => r.key).sort());
    const published = planPublished(buildReview(first, {}), first);
    assert.equal(published.additions.length, 0); assert.throws(() => assertFullReviewCoverage(published), /未审核/);
  });

  test(`${name}: interruption preserves job and resumes without a second submission`, async t => {
    const f = F.fixture(t), mock: any = await F.mockGateway(t), controller = new AbortController();
    mock.state.mode = 'running'; mock.state.onPoll = () => controller.abort(new Error('test interruption'));
    const result = await run(index, f, mock, [], { signal: controller.signal });
    assert.equal(result.exitCode, 130);
    const saved = records(f);
    assert.equal(saved.length, 1); assert.equal(saved[0].status, 'interrupted'); assert.ok(saved[0].jobId);
    assert.equal(saved[0].review.verdict, 'pending'); assert.equal(saved[0].asset, undefined);
    mock.state.mode = 'success'; mock.state.onPoll = null;
    const resumed = await run(index, f, mock);
    assert.equal(resumed.exitCode, 0);
    assert.equal(mock.state.posts.length, index === 1 ? 2 : 1);
    assert.equal(records(f)[0].recordId, saved[0].recordId);
    assert.equal(records(f)[0].seed, saved[0].seed);
    assert.equal(fs.existsSync(path.join(f.output, 'manifest.json')), false);
  });
}

test('gateway resolution has explicit precedence and rejects unsafe or empty configuration', () => {
  const env = { GATEWAY_URL: 'http://127.0.0.1:3101/', BASE: 'http://127.0.0.1:3102', AICS_COMMS_BASE: 'http://127.0.0.1:3103' };
  assert.equal(gatewayUrl('http://localhost:3999/', env), 'http://localhost:3999');
  assert.equal(gatewayUrl(undefined, env), 'http://127.0.0.1:3101');
  delete env.GATEWAY_URL; assert.equal(gatewayUrl(undefined, env), 'http://127.0.0.1:3102');
  delete env.BASE; assert.equal(gatewayUrl(undefined, env), 'http://127.0.0.1:3103');
  assert.equal(gatewayUrl(undefined, {}), 'http://127.0.0.1:3000');
  for (const bad of ['', 'garbage', 'file:///tmp/foo', 'http://user:pass@localhost', 'http://localhost/?secret=x', 'http://localhost/#x']) {
    assert.throws(() => gatewayUrl(bad, {}), /gateway/);
  }
});

test('all entry flags use the selected gateway over conflicting environment settings', async t => {
  for (let index = 0; index < modules.length; index++) {
    const f = F.fixture(t), mock = await F.mockGateway(t);
    f.env.GATEWAY_URL = 'http://127.0.0.1:1'; f.env.BASE = 'http://127.0.0.1:2'; f.env.AICS_COMMS_BASE = 'http://127.0.0.1:3';
    assert.equal((await run(index, f, mock)).exitCode, 0);
    assert.ok(mock.state.posts.length > 0);
  }
});

test('uncertain submissions are recorded and require explicit retry-unknown', async t => {
  for (const mode of ['bad-submit', 'missing-id']) {
    const f = F.fixture(t), mock = await F.mockGateway(t);
    mock.state.mode = mode;
    assert.equal((await run(2, f, mock)).exitCode, 1);
    assert.equal(records(f)[0].status, 'submission-unknown');
    assert.equal(mock.state.posts.length, 1);
    mock.state.mode = 'success';
    assert.equal((await run(2, f, mock)).exitCode, 1); assert.equal(mock.state.posts.length, 1);
    assert.equal((await run(2, f, mock, ['--retry-unknown'])).exitCode, 0);
    assert.equal(mock.state.posts.length, 2);
    const saved = records(f);
    assert.equal(saved.length, 2); assert.equal(saved[0].review.verdict, 'pending');
    assert.notEqual(saved[0].recordId, saved[1].recordId);
  }
});

test('bad poll, wrong job, result HTTP failure and redirect retain the known job', async t => {
  for (const mode of ['bad-poll', 'wrong-id', 'http-error', 'redirect']) {
    const f = F.fixture(t), mock = await F.mockGateway(t);
    mock.state.mode = mode;
    assert.equal((await run(2, f, mock)).exitCode, 1);
    assert.equal(records(f)[0].status, 'recoverable'); assert.equal(mock.state.posts.length, 1);
    mock.state.mode = 'success';
    assert.equal((await run(2, f, mock)).exitCode, 0);
    assert.equal(mock.state.posts.length, 1);
  }
});

test('failed jobs and malformed/foreign result bodies never become successful or reviewed', async t => {
  for (const mode of ['failed', 'missing-result', 'foreign', 'html', 'bad-image', 'truncated']) {
    const f = F.fixture(t), mock = await F.mockGateway(t);
    mock.state.mode = mode;
    assert.equal((await run(2, f, mock)).exitCode, 1);
    const saved = records(f);
    assert.equal(saved.length, 2); assert.equal(mock.state.posts.length, 2);
    assert.ok(saved.every((r: any) => r.status === 'failed' && r.review.verdict === 'pending' && !r.asset));
    assert.ok(saved.every((r: any) => r.jobId && r.error));
    assert.equal(fs.existsSync(path.join(f.output, 'manifest.json')), false);
  }
});

test('retry seed and attempt provenance report the actual second candidate', async t => {
  const f = F.fixture(t), mock: any = await F.mockGateway(t);
  mock.state.mode = 'retry-once';
  assert.equal((await run(2, f, mock)).exitCode, 0);
  const saved = records(f);
  assert.equal(saved[0].status, 'failed'); assert.equal(saved[1].status, 'succeeded');
  assert.equal(saved[1].attempt, 2); assert.equal(saved[1].seed, saved[0].seed + 7919);
  assert.equal(mock.state.posts[1].seed, saved[1].seed);
  assert.throws(() => buildReview(saved, { [saved[0].key]: { verdict: 'pass', recordId: saved[0].recordId } }), /succeeded/);
});

test('input changes, forced reruns and damaged images create distinct pending identities', async t => {
  const f = F.fixture(t), mock = await F.mockGateway(t);
  await run(1, f, mock, ['--limit', '1']);
  const first = records(f)[0], decision = { [first.key]: { verdict: 'pass', recordId: first.recordId } };
  await run(1, f, mock, ['--limit', '1', '--force']);
  const second = records(f)[1];
  assert.notEqual(first.recordId, second.recordId); assert.notEqual(first.image, second.image);
  assert.equal(first.inputVersion, second.inputVersion);
  assert.throws(() => buildReview(records(f), decision, { latestOnly: true }), /latest/);
  const presetsFile = path.join(f.root, 'data/presets.json');
  const presets = JSON.parse(fs.readFileSync(presetsFile, 'utf8')); presets.fixtureRevision = 2;
  F.writeJson(presetsFile, presets);
  await run(1, f, mock, ['--limit', '1']);
  const third = records(f)[2]; assert.notEqual(third.inputVersion, first.inputVersion);
  fs.writeFileSync(path.join(f.output, third.image), 'broken');
  await run(1, f, mock, ['--limit', '1']);
  assert.equal(records(f)[2].status, 'invalid-asset'); assert.equal(records(f)[3].status, 'succeeded');
  assert.throws(() => buildReview(records(f), { [third.key]: { verdict: 'pass', recordId: third.recordId } }), /succeeded/);
});

test('per-record ledger restores a torn manifest and rejects a forged candidate pass', async t => {
  const f = F.fixture(t), mock = await F.mockGateway(t);
  await run(0, f, mock); const first = records(f);
  fs.writeFileSync(path.join(f.output, 'generation-manifest.json'), '{');
  await run(0, f, mock); assert.deepEqual(records(f), first); assert.equal(mock.state.posts.length, 1);
  const forged = { ...first[0], review: { verdict: 'pass', recordId: first[0].recordId, reviewedAt: 'fake' } };
  F.writeJson(path.join(f.output, 'records', `${forged.candidateId}.json`), forged);
  await assert.rejects(run(0, f, mock), /forged/);
  assert.equal(mock.state.posts.length, 1);
});

test('production roots, active directories and junction outputs are refused before requesting a model', async t => {
  const f = F.fixture(t), mock = await F.mockGateway(t);
  const before = F.tree(f.root), active = F.tree(path.dirname(f.manifest));
  for (const output of [path.join(f.root, 'assets/new'), path.join(f.root, 'data/new'), path.dirname(f.manifest),
    path.join(f.env.AI_WORKSPACE_ROOT, 'SceneShowcase/new'), path.join(f.env.AI_WORKSPACE_ROOT, 'CharacterReferences/new')]) {
    const args = ['--root', f.root, '--output', output, '--gateway', mock.origin];
    await assert.rejects(modules[2].main(args, { env: f.env, fetchImpl: mock.fetchImpl }), /overlaps/);
  }
  fs.mkdirSync(f.output);
  fs.symlinkSync(path.join(f.root, 'assets'), path.join(f.output, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(modules[2].main(['--root', f.root, '--output', path.join(f.output, 'link/new')], { env: f.env }), /junction/);
  assert.equal(mock.state.posts.length, 0); assert.deepEqual(F.tree(f.root), before);
  assert.deepEqual(F.tree(path.dirname(f.manifest)), active);
});

test('existing source selection and redo-mine never replace hand-uploaded entries', async t => {
  const f = F.fixture(t);
  const id = 'pc_fixture_bp1';
  F.writeJson(f.manifest, { entries: [{ id, type: 'popular', provenance: { notes: 'manual upload' } }] });
  for (const args of [[], ['--redo-mine']]) {
    const { result } = await F.guarded(f, () => modules[2].main([...f.args, '--dry-run', ...args], { env: f.env }), { preview: true });
    assert.equal(result.count, 0);
  }
  F.writeJson(f.manifest, { entries: [{ id, type: 'popular', provenance: { notes: 'gap-render' } }] });
  const { result } = await F.guarded(f, () => modules[2].main([...f.args, '--dry-run', '--redo-mine'], { env: f.env }), { preview: true });
  assert.equal(result.count, 1);
  f.env.SCENE_SHOWCASE_DIR = path.join(f.temporary, 'missing-source');
  await assert.rejects(modules[2].main([...f.args, '--dry-run'], { env: f.env }), /source|fallback/);
  const explicit = await F.guarded(f, () => modules[2].main([...f.args, '--dry-run', '--manifest', f.manifest, '--redo-mine'], { env: f.env }), { preview: true });
  assert.equal(explicit.result.count, 1);
});

test('invalid arguments and invented review/publish flags cannot invoke generation', async t => {
  const f = F.fixture(t);
  for (const entry of modules) {
    for (const args of [[], ['--output'], ['--concurrency', '0'], ['--concurrency', 'NaN'], ['--publish'], ['--review', 'pass'], ['--apply']]) {
      await assert.rejects(entry.main(args, { env: f.env }), /required|requires|concurrency|unknown/);
    }
  }
  assert.equal(fs.existsSync(f.output), false);
  assert.throws(() => validatePng(Buffer.from('not a PNG')), /PNG/);
  assert.deepEqual(validatePng(F.png()), { mime: 'image/png', width: 1, height: 1 });
});

test('batch-specific manifests remain consumable by the existing manual review and publisher functions', async t => {
  const f = F.fixture(t), mock = await F.mockGateway(t);
  await run(1, f, mock);
  const sceneFile = path.join(f.output, 'scene-generation-manifest.json');
  const popularFile = path.join(f.output, 'popular-generation-manifest.json');
  const scenes = JSON.parse(fs.readFileSync(sceneFile, 'utf8'));
  const popular = JSON.parse(fs.readFileSync(popularFile, 'utf8'));
  assert.equal(scenes.length, 1); assert.equal(popular.length, 1);
  assert.ok(scenes.every((r: any) => r.batch === 'scene'));
  assert.ok(popular.every((r: any) => r.batch === 'popular'));
  assert.equal(fs.existsSync(scenePublisher.sourcePathFor(scenes[0], sceneFile)), true);
  assert.equal(fs.existsSync(popularPublisher.sourcePathFor(popular[0], popularFile)), true);
  assert.deepEqual(popularPublisher.loadPassedRecords(popularFile, path.join(f.output, 'missing-audit.json')), []);
  const review = buildReview(scenes, { [scenes[0].key]: { verdict: 'pass', recordId: scenes[0].recordId, notes: 'synthetic test decision' } });
  const plan = scenePublisher.planPublished(review, scenes);
  assert.equal(plan.additions.length, 1);
  assert.doesNotThrow(() => scenePublisher.assertFullReviewCoverage(plan));
  assert.equal(scenes[0].review.verdict, 'pending', 'a separate review must not mutate candidate evidence');
});

test('hard-killed CLI leaves a resumable job and its stale lock recovers without duplicate POST', { timeout: 15000 }, async t => {
  const f = F.fixture(t), mock: any = await F.mockGateway(t);
  mock.state.mode = 'running';
  const guardFile = path.join(f.temporary, 'child-probe.cjs');
  fs.writeFileSync(guardFile, `
    const fs=require('node:fs'),path=require('node:path');
    const root=path.resolve(process.env.CANDIDATE_OUTPUT);
    for(const name of ['writeFileSync','appendFileSync','mkdirSync','renameSync','unlinkSync','rmSync','rmdirSync','copyFileSync','cpSync']) {
      const original=fs[name]; fs[name]=(...args)=>{
        for(const target of [args[0],...(['renameSync','copyFileSync','cpSync'].includes(name)?[args[1]]:[])]) {
          const resolved=path.resolve(target);
          if(resolved!==root&&!resolved.startsWith(root+path.sep)) throw Error('child production write forbidden');
        }
        return original(...args);
      };
    }
    const fetchOriginal=global.fetch;
    global.fetch=(url,init)=>{if(new URL(url).origin!==process.env.MOCK_ORIGIN)throw Error('external network forbidden');return fetchOriginal(url,init);};
  `);
  const child = spawn(process.execPath, ['--require', guardFile, path.join(F.CODE_ROOT, 'scripts/maintenance', F.entries[0]),
    ...f.args, '--gateway', mock.origin], {
    cwd: f.temporary, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...f.env, CANDIDATE_OUTPUT: f.output, MOCK_ORIGIN: mock.origin },
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.resume();
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  mock.state.onPoll = () => child.kill('SIGKILL');
  await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  assert.equal(mock.state.posts.length, 1, stderr);
  const saved = records(f)[0];
  assert.equal(saved.status, 'submitted'); assert.ok(saved.jobId);
  assert.equal(fs.existsSync(path.join(f.output, '.generation.lock')), true);
  mock.state.mode = 'success'; mock.state.onPoll = null;
  assert.equal((await run(0, f, mock)).exitCode, 0);
  assert.equal(mock.state.posts.length, 1);
  assert.equal(records(f)[0].recordId, saved.recordId);
  assert.equal(records(f)[0].review.verdict, 'pending');
  assert.equal(fs.existsSync(path.join(f.output, '.generation.lock')), false);
});

test('timeout and concurrent ownership cannot silently resubmit a running job', async t => {
  const f = F.fixture(t), mock = await F.mockGateway(t);
  mock.state.mode = 'running';
  assert.equal((await run(0, f, mock, [], { timeoutMs: 60 })).exitCode, 1);
  assert.equal(records(f)[0].status, 'recoverable'); assert.equal(mock.state.posts.length, 1);
  F.writeJson(path.join(f.output, '.generation.lock'), { pid: process.pid, host: (require('node:os') as typeof import('node:os')).hostname() });
  await assert.rejects(run(0, f, mock), /in use/);
  assert.equal(mock.state.posts.length, 1);
  fs.unlinkSync(path.join(f.output, '.generation.lock'));
  mock.state.mode = 'success';
  assert.equal((await run(0, f, mock)).exitCode, 0);
  assert.equal(mock.state.posts.length, 1);
});

test('interrupted image writes leave only staging bytes and recover using the saved job', async t => {
  const f = F.fixture(t), mock = await F.mockGateway(t);
  const original = fs.writeFileSync;
  let injected = false;
  fs.writeFileSync = (file, value, ...args) => {
    if (!injected && String(file).includes(`${path.sep}images${path.sep}`) && String(file).endsWith('.tmp')) {
      injected = true;
      original(file, value.subarray(0, 20), ...args);
      throw new Error('simulated interrupted image write');
    }
    return original(file, value, ...args);
  };
  try { assert.equal((await run(0, f, mock)).exitCode, 1); }
  finally { fs.writeFileSync = original; }
  assert.equal(injected, true);
  const saved = records(f)[0];
  assert.equal(saved.status, 'recoverable'); assert.ok(saved.jobId);
  assert.equal(fs.existsSync(path.join(f.output, saved.image)), false);
  assert.ok(fs.readdirSync(path.join(f.output, 'images')).some(name => name.endsWith('.tmp')));
  assert.equal((await run(0, f, mock)).exitCode, 0);
  assert.equal(mock.state.posts.length, 1);
  assert.equal(records(f)[0].recordId, saved.recordId);
  assert.deepEqual(fs.readFileSync(path.join(f.output, saved.image)), mock.image);
  assert.equal(records(f)[0].review.verdict, 'pending');
});

test('payload snapshots retain the pre-fix prompts, bindings, dimensions and sampling values', t => {
  // Captured by extracting ONLY the original pure functions at 9ab9cfca3ead6d41b300969be91233424513e7c9.
  // Synthetic SFW fixtures only; no original entry was required or executed.
  const f = F.fixture(t);
  const expected = {
    ref_01_face_closeup: '94e1d9371f4af32be8d50f3cc0236d5f0c48cd72c0135d253fa274be9d11d08e',
    ref_02_half_medium: 'e756ab0a0eaed58a96338796425e3bc221db5999e21d1018d6be43f9c00b4694',
    ref_03_full_dynamic: '1591c0c73828be59df48ffe993873185776f12182fc1bd7406a07959c684b600',
    ref_04_back_rear: '24406b68a8572ebb8b21975836c37094a6c12a1ae6846f24a492df97c95f73f2',
  };
  for (const [persId, hash] of Object.entries(expected)) {
    assert.equal(F.sha(JSON.stringify(modules[0].buildPayload(f.character, f.character.outfits[0], persId, 123))), hash);
  }
  const tasks = modules[1].collectAllSceneTasks({}, modules[1].loadInputs({ root: f.root }));
  const payload = (task: any, characterId: any = task.characterId) => modules[1].buildPayload({ ...task, characterId, seed: 123 });
  assert.equal(F.sha(JSON.stringify(payload(tasks[0]))), '593aeb1db0b7f402d3e40b481da899e6320e89bf2fffb2c3639796ee8f154ca6');
  for (const [character, hash] of Object.entries({
    nene: '75a003ccdf092e76e84993be6605247683045d6615ac1b2f555da703e0cdc9dc',
    natsume: 'cfa9057ca57e15873c5f9089275524cc3ae82c88fa3fea0c72487f6fbc64a4a9',
    generic: '5d8306f0ce1489fed3bdb34f27af957712980e056bc846eaf01c84a6c458c428',
  })) assert.equal(F.sha(JSON.stringify(payload(tasks[1], character))), hash);
  const gap = modules[2].collectTasks({}, modules[2].loadInputs({ root: f.root, env: f.env }))[0];
  assert.equal(F.sha(JSON.stringify(gap.payload(1))), 'b3289c106af3263b91d4684a585ff0cd0d9b7c117b18481baee0c334b6fc5ca6');
  assert.equal(F.sha(JSON.stringify(gap.payload(2))), 'b9e68dc60e41f8a0784357e8bf40dfaa25e68539b73564591049b5a2bd9f3ccb');
});
