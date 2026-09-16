'use strict';
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { test }: typeof import('node:test') = require('node:test');
const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const { fork }: typeof import('node:child_process') = require('node:child_process');
const F: typeof import('./generation-safety-fixture') = require('./generation-safety-fixture');
const R: typeof import('../lib/reference-candidate-review') = require('../lib/reference-candidate-review');
const P: typeof import('../lib/reference-candidate-publish') = require('../lib/reference-candidate-publish');
const cli: typeof import('../maintenance/reference-candidate-workflow') = require('../maintenance/reference-candidate-workflow');
const generator: typeof import('../maintenance/render-all-outfits-references') = require('../maintenance/render-all-outfits-references');
const { referenceView }: typeof import('./reference-view-fixture') = require('./reference-view-fixture');
const Ajv: any = require('ajv');
const ajv: any = new Ajv({ allErrors: true });
const validateView = ajv.compile((require('../contracts/character-reference-view.schema.json') as typeof import('../contracts/character-reference-view.schema.json')));

async function fixture(t: any) {
  const f = F.fixture(t);
  f.gateway = await F.mockGateway(t);
  f.source = path.join(f.temporary, 'old-library');
  f.target = path.join(f.temporary, 'new-library');
  fs.mkdirSync(f.source);
  fs.mkdirSync(path.join(f.source, 'retained'));
  fs.writeFileSync(path.join(f.source, 'retained', 'portrait.png'), F.png());
  const view = referenceView({ retainedUrl: '/character-references/retained/portrait.png' });
  assert.ok(validateView(view), ajv.errorsText(validateView.errors));
  F.writeJson(path.join(f.root, 'data/character-reference-view.json'), view);
  f.args.push('--gateway', f.gateway.origin);
  await F.guarded(f, () => generator.main(f.args, { env: f.env, fetchImpl: f.gateway.fetchImpl, pollMs: 1 }));
  f.from = path.join(f.output, 'reference-generation-manifest.json');
  f.inspection = R.inspectCandidates({ from: f.from, root: f.root });
  f.options = { from: f.from, root: f.root, source: f.source, target: f.target,
    review: path.join(f.output, 'manual-review.json') };
  f.decision = (verdict: any) => {
    const item = f.inspection.items[0];
    return { [item.key]: { verdict, recordId: item.recordId, sha256: item.sha256,
      inputVersion: item.inputVersion, reviewedAt: '2026-09-15T01:00:00.000Z', notes: 'synthetic fixture decision' } };
  };
  f.review = (verdict: any) => {
    const review = R.collectReview(f.inspection, verdict ? f.decision(verdict) : {}, { file: 'decisions.json', sha256: 'a'.repeat(64) });
    R.saveReview(f.inspection, f.options.review, review);
    return review;
  };
  return f;
}

test('candidate inspection proves bytes/source identity, never image quality or human approval', async t => {
  const f = await fixture(t);
  assert.equal(f.inspection.items[0].integrity, 'pass');
  assert.equal(f.inspection.items[0].review, 'pending');
  assert.equal(f.inspection.records[0].review.verdict, 'pending');
  assert.equal(f.gateway.state.posts.length, 1);
});

test('help/plan and full dry-run never write or call upstream', async t => {
  const f = await fixture(t);
  for (const args of [['full', '--help', '--root', 'missing'], ['publish', '--plan'],
    ['full', ...f.args, '--source', f.source, '--target', f.target, '--dry-run']]) {
    const result = await F.guarded(f, () => cli.main(args, { env: f.env,
      fetchImpl: () => { throw new Error('network forbidden'); } }), { preview: true });
    assert.equal(result.result.exitCode, 0);
    assert.deepEqual(result.writes, []);
  }
});

test('full workflow resumes known candidates and waits for human review without publication', async t => {
  const f = await fixture(t);
  const before = F.tree(f.source);
  const { result } = await F.guarded(f, () => cli.main(['full', ...f.args, '--source', f.source, '--target', f.target],
    { env: f.env, fetchImpl: () => { throw new Error('already generated'); } }));
  assert.equal(result.exitCode, 3);
  assert.equal(result.publication, 'pending-human-review');
  assert.equal(fs.existsSync(f.target), false);
  assert.deepEqual(F.tree(f.source), before);
});

test('full with an explicit current review reaches publication preview without activating or publishing', async t => {
  const f = await fixture(t); f.review('pass');
  const { result } = await F.guarded(f, () => cli.main(['full', ...f.args, '--source', f.source,
    '--target', f.target, '--review', f.options.review], { env: f.env, fetchImpl: f.gateway.fetchImpl }));
  assert.equal(result.mode, 'preview');
  assert.equal(result.ready, true);
  assert.equal(fs.existsSync(f.target), false);
  assert.throws(() => cli.parse(['full', '--apply'], {}), /Invalid/);
});

test('review CLI records supplied decisions without changing the candidate ledger', async t => {
  const f = await fixture(t);
  const decisions = path.join(f.output, 'decisions.json');
  F.writeJson(decisions, f.decision('pass'));
  const before = fs.readFileSync(f.from);
  const { result } = await F.guarded(f, () => cli.main(['review', '--root', f.root, '--from', f.from,
    '--decisions', decisions, '--out', f.options.review], { env: f.env }));
  assert.equal(result.reviewed, 1);
  assert.equal(result.pending, 0);
  assert.deepEqual(fs.readFileSync(f.from), before);
});

test('human decisions bind exact record, source, image hash and explicit review time', async t => {
  const f = await fixture(t);
  const key = f.inspection.items[0].key;
  for (const field of ['recordId', 'sha256', 'inputVersion', 'reviewedAt']) {
    const decisions = f.decision('pass');
    decisions[key][field] = 'wrong';
    assert.throws(() => R.collectReview(f.inspection, decisions, {}), /Decision/);
  }
  const review = f.review('pass');
  assert.equal(R.attachReview(f.inspection, review)[0].review, 'pass');
  assert.throws(() => R.saveReview(f.inspection, f.options.review, review), /exist/i);
  assert.throws(() => R.saveReview(f.inspection, f.from, review), /Review output/);
  assert.throws(() => R.saveReview(f.inspection, path.join(f.root, 'manual-review.json'), review), /Review output/);
});

test('publication preview is read-only; apply creates one complete version and preserves source/project', async t => {
  const f = await fixture(t);
  f.review('pass');
  const original = F.tree(f.source), project = F.tree(f.root), candidates = F.tree(f.output);
  const { result } = await F.guarded(f, () => P.publishReferenceCandidates(f.options), { preview: true });
  assert.equal(result.ready, true);
  assert.equal(fs.existsSync(f.target), false);
  const published = await P.publishReferenceCandidates({ ...f.options, apply: true });
  const resolved = P.resolveReferenceRelease(f.target, { dataRoot: f.root });
  assert.equal(resolved!.identity, published.identity);
  const view = R.json(resolved!.viewFile);
  assert.ok(validateView(view), ajv.errorsText(validateView.errors));
  assert.equal(view.fixture.outfits[0].outfitId, 'coat');
  assert.equal(view.fixture.outfits[0].references[0].pending, false);
  assert.equal(view.fixture.outfits[0].references[0].url, '/character-references/' + f.inspection.items[0].intendedReferencePath);
  assert.equal(resolved!.release.approvals[0].recordId, f.inspection.items[0].recordId);
  assert.equal(resolved!.release.approvals[0].review.verdict, 'pass');
  assert.deepEqual(F.tree(f.source), original);
  assert.deepEqual(F.tree(f.root), project);
  assert.deepEqual(F.tree(f.output), candidates);
  const second = await P.publishReferenceCandidates({ ...f.options, apply: true });
  assert.equal(second.mode, 'already-published');
  assert.equal(second.identity, published.identity);
});

test('publication uses canonical outfitId and refuses a standards-shaped or ambiguous view', async t => {
  const f = await fixture(t); f.review('pass');
  const file = path.join(f.root, 'data/character-reference-view.json');
  const view = R.json(file);
  const outfit = view.fixture.outfits[0];
  outfit.id = outfit.outfitId;
  delete outfit.outfitId;
  F.writeJson(file, view);
  await assert.rejects(P.publishReferenceCandidates({ ...f.options, apply: true }), /absent or ambiguous/);
  outfit.outfitId = outfit.id;
  delete outfit.id;
  view.fixture.outfits.push(structuredClone(outfit));
  F.writeJson(file, view);
  await assert.rejects(P.publishReferenceCandidates({ ...f.options, apply: true }), /absent or ambiguous/);
  assert.equal(fs.existsSync(f.target), false);
});

test('release identity protects approval evidence separately from the runtime projection', async t => {
  const f = await fixture(t); f.review('pass');
  await P.publishReferenceCandidates({ ...f.options, apply: true });
  const file = path.join(f.target, P.MARKER), release = R.json(file);
  release.approvals[0].review.reviewedAt = '2026-09-14T00:00:00.000Z';
  F.writeJson(file, release);
  assert.throws(() => P.resolveReferenceRelease(f.target, { dataRoot: f.root }), /identity/);
});

for (const verdict of [null, 'fail']) test('missing/failed human decision refuses apply: ' + verdict, async t => {
  const f = await fixture(t); f.review(verdict);
  const preview = await P.publishReferenceCandidates(f.options);
  assert.equal(preview.ready, false);
  await assert.rejects(P.publishReferenceCandidates({ ...f.options, apply: true }), /human approval/);
  assert.equal(fs.existsSync(f.target), false);
});

test('a new attempt cannot inherit review of the previous successful candidate', async t => {
  const f = await fixture(t); f.review('pass');
  await F.guarded(f, () => generator.main([...f.args, '--force', '--keys', f.inspection.items[0].key],
    { env: f.env, fetchImpl: f.gateway.fetchImpl, pollMs: 1 }));
  assert.equal(R.inspectCandidates(f.options).records.length, 2);
  await assert.rejects(P.publishReferenceCandidates({ ...f.options, apply: true }), /different candidate version/);
});

for (const mode of ['image', 'source']) test('changed ' + mode + ' invalidates approval before publication', async t => {
  const f = await fixture(t); f.review('pass');
  if (mode === 'image') fs.writeFileSync(path.join(f.output, f.inspection.items[0].image), 'bad bytes');
  else fs.appendFileSync(path.join(f.root, R.SOURCE), '\n');
  const current = R.inspectCandidates(f.options);
  assert.notEqual(current.items[0].integrity, 'pass');
  await assert.rejects(P.publishReferenceCandidates({ ...f.options, apply: true }), /human approval/);
  assert.equal(fs.existsSync(f.target), false);
});

test('omitted ledger records and forged paths are refused', async t => {
  const f = await fixture(t);
  F.writeJson(f.from, []);
  assert.throws(() => R.inspectCandidates(f.options), /omits/);
  for (const value of ['../escape.png', 'x/../escape.png', 'x/con.png', 'x/a%2fb.png', 'x/a:stream.png']) assert.throws(() => R.relativeImage(value), /Unsafe/);
});

test('publication refuses overlap, pre-existing destinations and a missing indexed image', async t => {
  const f = await fixture(t); f.review('pass');
  for (const target of [f.source, f.output, path.join(f.root, 'assets/new')]) {
    await assert.rejects(P.publishReferenceCandidates({ ...f.options, target, apply: true }), /separate|overlap/);
  }
  fs.mkdirSync(f.target);
  await assert.rejects(P.publishReferenceCandidates({ ...f.options, apply: true }), /already exists/);
  fs.unlinkSync(path.join(f.source, 'retained/portrait.png'));
  await assert.rejects(P.publishReferenceCandidates(f.options), /missing image/);
});

test('a late input change leaves the active library intact and never exposes a partial target', async t => {
  const f = await fixture(t); f.review('pass');
  const original = F.tree(f.source);
  await assert.rejects(P.publishReferenceCandidates({ ...f.options, apply: true }, { onPhase: (phase: any) => {
    if (phase === 'prepared') fs.writeFileSync(path.join(f.output, f.inspection.items[0].image), 'changed');
  } }), /inputs changed/);
  assert.equal(fs.existsSync(f.target), false);
  assert.deepEqual(F.tree(f.source), original);
});

test('version resolver refuses changed images, index bytes and mismatched project versions', async t => {
  const f = await fixture(t); f.review('pass');
  await P.publishReferenceCandidates({ ...f.options, apply: true });
  const file = path.join(f.target, f.inspection.items[0].intendedReferencePath), original = fs.readFileSync(file);
  fs.writeFileSync(file, 'bad');
  assert.throws(() => P.resolveReferenceRelease(f.target, { dataRoot: f.root }), /bytes changed/);
  fs.writeFileSync(file, original);
  fs.appendFileSync(path.join(f.target, P.VIEW), '\n');
  assert.throws(() => P.resolveReferenceRelease(f.target, { dataRoot: f.root }), /index changed/);
});

test('junction targets and candidate image links are rejected without changing external files', async t => {
  const f = await fixture(t); f.review('pass');
  const outside = path.join(f.temporary, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, f.target, 'junction');
  const original = F.tree(outside);
  await assert.rejects(P.publishReferenceCandidates({ ...f.options, apply: true }), /junction|symlink/);
  assert.deepEqual(F.tree(outside), original);
});

test('a competing process cannot steal a live publication lock', async t => {
  const f = await fixture(t); f.review('pass');
  const optionsFile = path.join(f.temporary, 'competing-options.json');
  F.writeJson(optionsFile, { ...f.options, apply: true });
  const published = await P.publishReferenceCandidates({ ...f.options, apply: true }, { onPhase: async (phase: any) => {
    if (phase !== 'prepared') return;
    const result: any = await new Promise<any>((resolve, reject) => {
      const worker = fork(path.join(__dirname, 'reference-publication-worker.js'), [optionsFile, 'never'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      let result: any;
      const timer = setTimeout(() => { worker.kill('SIGKILL'); reject(new Error('Competing publisher timed out')); }, 30000);
      worker.on('message', (message: any) => { result = message; });
      worker.on('error', error => { clearTimeout(timer); reject(error); });
      worker.on('exit', () => { clearTimeout(timer); resolve(result); });
    });
    assert.equal(result.code, 'BUSY');
    assert.equal(fs.existsSync(f.target), false);
  } });
  assert.equal(P.resolveReferenceRelease!(f.target, { dataRoot: f.root })!.identity, published.identity);
});

test('process death after staging recovers the stale lock and publishes without changing the old library', async t => {
  const f = await fixture(t); f.review('pass');
  const optionsFile = path.join(f.temporary, 'publish-options.json');
  F.writeJson(optionsFile, { ...f.options, apply: true });
  const original = F.tree(f.source);
  await new Promise((resolve, reject) => {
    const worker = fork(path.join(__dirname, 'reference-publication-worker.js'), [optionsFile, 'prepared'], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let reached = false, errorText = '';
    worker.stderr!.on('data', bytes => { errorText += bytes; });
    const timer = setTimeout(() => { worker.kill('SIGKILL'); reject(new Error('Publication worker timed out: ' + errorText)); }, 30000);
    worker.on('message', (message: any) => {
      if (message.phase === 'prepared') { reached = true; worker.kill('SIGKILL'); }
      else if (message.error) { clearTimeout(timer); reject(new Error(message.error)); }
    });
    worker.on('error', error => { clearTimeout(timer); reject(error); });
    worker.on('exit', () => { clearTimeout(timer); reached ? resolve(undefined) : reject(new Error('Worker exited before staging: ' + errorText)); });
  });
  assert.equal(fs.existsSync(f.target), false);
  assert.deepEqual(F.tree(f.source), original);
  const retried = await P.publishReferenceCandidates({ ...f.options, apply: true });
  assert.equal(P.resolveReferenceRelease!(f.target, { dataRoot: f.root })!.identity, retried.identity);
  assert.deepEqual(F.tree(f.source), original);
});
