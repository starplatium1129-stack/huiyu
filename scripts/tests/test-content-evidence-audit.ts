import { errorCode as runtimeErrorCode } from '../lib/runtime-errors';
'use strict';

import { PathOrFileDescriptor } from 'node:fs';

const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const crypto: typeof import('node:crypto') = require('node:crypto');
const cp: typeof import('node:child_process') = require('node:child_process');
const { test }: typeof import('node:test') = require('node:test');
const { fixture }: typeof import('./content-evidence-fixture') = require('./content-evidence-fixture');
const { snapshot }: typeof import('./content-history-fixture') = require('./content-history-fixture');
const { auditContentEvidence: audit }: typeof import('../lib/content-evidence-audit') = require('../lib/content-evidence-audit');
const { parse, main }: typeof import('../maintenance/audit-content-evidence') = require('../maintenance/audit-content-evidence');
const script = path.resolve(__dirname, '../maintenance/audit-content-evidence.js');

test('native ledger/source/payload/asset/decision/publication evidence match independently and never expose text or claim quality', (t) => {
  const f = fixture(t);
  const before = snapshot(f.base);
  const result = audit({ ...f.options, publication: 'publication.json', publishedRoot: f.publishedRoot });
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  assert.equal(result.structure.status, 'passed');
  const item = result.items[0];
  for (const key of ['source', 'payload', 'version', 'asset']) assert.equal(item[key].status, 'verified');
  assert.equal(item.review.status, 'approved');
  assert.equal(item.review.authenticity, 'unverified');
  assert.equal(item.publication.status, 'evidence-verified');
  assert.equal(item.publication.activation, 'unknown');
  assert.equal(item.asset.imageQuality, 'unverified');
  assert.equal(result.acceptance.publicationPerformed, false);
  assert.ok(!JSON.stringify(result).includes('NEUTRAL_PRIVATE_FIXTURE_PAYLOAD'));
  assert.ok(!JSON.stringify(result).includes('PRIVATE_REVIEW_NOTES'));
  assert.deepEqual(snapshot(f.base), before);
});

test('structure success and verified asset do not promote native pending review or absent publication', (t) => {
  const f = fixture(t);
  const result = audit({ ...f.options, decisions: undefined });
  assert.equal(result.structure.status, 'passed');
  assert.equal(result.items[0].asset.status, 'verified');
  assert.equal(result.items[0].review.status, 'pending');
  assert.equal(result.items[0].publication.status, 'not-provided');
  assert.equal(result.exitCode, 3);
});

test('in-flight native generation states never inherit an approval or certify generation completion', (t) => {
  const f = fixture(t);
  for (const status of ['submitting', 'submitted', 'downloading', 'recoverable']) {
    f.record.status = status;
    f.exportRecords();
    const result = audit(f.options);
    assert.equal(result.structure.status, 'passed');
    assert.equal(result.items[0].review.status, 'stale');
    assert.equal(result.exitCode, 3);
  }
});

test('source or recipe changes make old human approval stale without rewriting original records', (t) => {
  const f = fixture(t);
  f.source('data/neutral.json', { id: 'object', version: 2 });
  const before = snapshot(f.base);
  const result = audit(f.options);
  assert.equal(result.items[0].source.status, 'stale');
  assert.equal(result.items[0].asset.status, 'verified');
  assert.equal(result.items[0].review.status, 'stale');
  assert.equal(result.exitCode, 3);
  assert.deepEqual(snapshot(f.base), before);
});

test('changed request bytes and bad asset bytes fail evidence checks while structure remains independently passed', (t) => {
  const f = fixture(t);
  f.record.payload.width = 1024;
  f.exportRecords();
  let result = audit(f.options);
  assert.equal(result.structure.status, 'passed');
  assert.equal(result.items[0].payload.status, 'mismatch');
  assert.equal(result.items[0].review.status, 'stale');
  assert.equal(result.exitCode, 1);
  f.record.payload.width = 512;
  f.exportRecords();
  f.put(f.record.image, Buffer.from('wrong asset bytes'));
  result = audit(f.options);
  assert.equal(result.items[0].asset.status, 'mismatch');
  assert.equal(result.exitCode, 1);
});

test('missing assets cannot be certified from declared hashes or review verdicts', (t) => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.candidateRoot, f.record.image));
  const result = audit(f.options);
  assert.equal(result.structure.status, 'passed');
  assert.equal(result.items[0].asset.status, 'missing');
  assert.equal(result.items[0].review.status, 'stale');
  assert.equal(result.exitCode, 1);
});

test('changed candidate record or input version invalidates prior approval, even with identical image bytes', (t) => {
  const f = fixture(t);
  f.record.updatedAt = '2026-09-04T00:00:00Z';
  f.exportRecords();
  let result = audit(f.options);
  assert.equal(result.items[0].freshness, 'current');
  assert.equal(result.items[0].review.status, 'stale');
  assert.equal(result.exitCode, 3);
  f.record.inputVersion = 'a'.repeat(64);
  f.exportRecords();
  result = audit(f.options);
  assert.equal(result.items[0].version.status, 'mismatch');
  assert.equal(result.items[0].review.status, 'stale');
  assert.equal(result.exitCode, 1);
});

test('duplicate IDs, missing ledger entries, forged inline approvals and hidden attempts fail closed', (t) => {
  const f = fixture(t);
  f.put('generation-manifest.json', [f.record, f.record]);
  assert.equal(audit(f.options).exitCode, 1);
  f.exportRecords();
  f.record.review.verdict = 'pass';
  f.exportRecords();
  assert.equal(audit(f.options).structure.status, 'invalid');
  f.record.review.verdict = 'pending';
  f.exportRecords();
  const id = crypto.randomUUID();
  const next = { ...f.record, candidateId: id, attempt: 2, recordId: `${f.record.key}@attempt-2-${id}`, image: `images/${id}.png` };
  next.asset = { ...f.record.asset, path: next.image };
  next.review = { verdict: 'pending', recordId: next.recordId };
  f.put(`records/${id}.json`, next);
  const result = audit(f.options);
  assert.equal(result.exitCode, 1);
  assert.ok(result.errors.some((error: any) => error.includes('omits authoritative')));
});

test('latest attempt is audited and cannot inherit an earlier attempt decision', (t) => {
  const f = fixture(t);
  const id = crypto.randomUUID();
  const next = { ...f.record, candidateId: id, attempt: 2, recordId: `${f.record.key}@attempt-2-${id}`, image: `images/${id}.png` };
  next.asset = { ...f.record.asset, path: next.image };
  next.review = { verdict: 'pending', recordId: next.recordId };
  f.put(next.image, f.read(f.candidateRoot, f.record.image));
  f.exportRecords([f.record, next]);
  const result = audit(f.options);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].recordId, next.recordId);
  assert.equal(result.items[0].review.status, 'stale');
  assert.equal(result.exitCode, 3);
});

test('unlisted source paths and unknown generator mappings remain unknown and are never read or executed', (t) => {
  const f = fixture(t);
  const read = fs.readFileSync;
  const source = path.join(f.root, 'data/neutral.json');
  const guard = t.mock.method(fs, 'readFileSync', (file: PathOrFileDescriptor, ...args) => {
    assert.notEqual(String(file), source, 'unlisted source must not be accessed');
    return read(file, ...args);
  });
  let result = audit({ ...f.options, sources: [] });
  assert.equal(result.items[0].source.status, 'unknown');
  assert.equal(result.exitCode, 3);
  guard.mock.restore();
  f.record.generator = 'unmapped-generator.js';
  f.put('candidate-run.json', { schemaVersion: 1, kind: 'generation-candidates', runId: f.record.runId, generator: f.record.generator });
  f.exportRecords();
  result = audit(f.options);
  assert.equal(result.items[0].version.status, 'unknown');
  assert.equal(result.exitCode, 3);
});

test('escaping asset symlinks are rejected without reading their targets', (t) => {
  const f = fixture(t);
  const outside = path.join(f.base, 'outside.bin');
  fs.writeFileSync(outside, 'outside');
  const image = path.join(f.candidateRoot, f.record.image);
  fs.unlinkSync(image);
  try { fs.symlinkSync(outside, image, 'file'); }
  catch (error) { if (runtimeErrorCode(error) === 'EPERM') { t.skip('file symlink unavailable; junction test below is unconditional'); return; } throw error; }
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (file: unknown, ...args) => { assert.notEqual(file, outside); return read(file, ...args); });
  const result = audit(f.options);
  assert.equal(result.items[0].asset.status, 'invalid');
  assert.equal(result.exitCode, 1);
});

test('candidate image directory junction is rejected before any bytes can escape', (t) => {
  const f = fixture(t);
  const outside = path.join(f.base, 'outside-images');
  fs.renameSync(path.join(f.candidateRoot, 'images'), outside);
  fs.symlinkSync(outside, path.join(f.candidateRoot, 'images'), process.platform === 'win32' ? 'junction' : 'dir');
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (file: unknown, ...args) => {
    assert.ok(!String(file).startsWith(outside));
    assert.notEqual(file, path.join(f.candidateRoot, f.record.image), 'do not read through the junction alias');
    return read(file, ...args);
  });
  assert.equal(audit(f.options).items[0].asset.status, 'invalid');
});

test('publication bindings and published bytes are checked separately; absent root is unknown, stale approval stays stale', (t) => {
  const f = fixture(t);
  assert.equal(audit({ ...f.options, publication: 'publication.json' }).items[0].publication.status, 'unknown');
  fs.writeFileSync(path.join(f.publishedRoot, 'objects/front.bin'), 'bad');
  let result = audit({ ...f.options, publication: 'publication.json', publishedRoot: f.publishedRoot });
  assert.equal(result.items[0].publication.status, 'invalid');
  assert.equal(result.exitCode, 1);
  f.publication.reviewSha256 = 'b'.repeat(64);
  f.put('publication.json', f.publication);
  result = audit({ ...f.options, publication: 'publication.json', publishedRoot: f.publishedRoot });
  assert.equal(result.items[0].publication.status, 'stale');
  assert.equal(result.acceptance.publicationPerformed, false);
});

test('explicit rejected human decision remains rejected; invalid decision structure fails without writing review', (t) => {
  const f = fixture(t);
  f.decisions.records[f.record.key].verdict = 'fail';
  f.put('decisions.json', f.decisions);
  assert.equal(audit(f.options).items[0].review.status, 'rejected');
  assert.equal(audit(f.options).exitCode, 1);
  f.put('decisions.json', { schemaVersion: 88 });
  assert.equal(audit(f.options).structure.status, 'invalid');
});

test('input drift during verification makes an otherwise approved result stale', (t) => {
  const f = fixture(t);
  const file = path.join(f.root, 'data/neutral.json');
  const read = fs.readFileSync;
  let calls = 0;
  t.mock.method(fs, 'readFileSync', (name: PathOrFileDescriptor, ...args) => {
    if (name === file && ++calls > 1) return Buffer.from('concurrent source change');
    return read(name, ...args);
  });
  const result = audit(f.options);
  assert.equal(result.items[0].review.status, 'stale');
  assert.ok(result.unknown.some((message: any) => message.includes('changed during audit')));
  assert.equal(result.exitCode, 3);
});

test('audit uses no write/process/network operations, and CLI prints matching statuses and exit codes', (t) => {
  const f = fixture(t);
  const before = snapshot(f.base);
  const output = cp.spawnSync(process.execPath, [script, '--root', f.root, '--candidate-root', f.candidateRoot,
    '--manifest', f.options.manifest, '--source', 'data/neutral.json', '--recipe', f.options.recipe, '--decisions', 'decisions.json', '--json'], { encoding: 'utf8' });
  assert.equal(output.status, 0, output.stderr || output.stdout);
  assert.equal(JSON.parse(output.stdout).items[0].review.status, 'approved');
  const mocks = ['writeFileSync', 'appendFileSync', 'renameSync', 'mkdirSync', 'rmSync', 'unlinkSync', 'copyFileSync']
    .map((method) => t.mock.method(fs, method, () => { throw new Error(`Unexpected ${method}`); }));
  const proc = t.mock.method(cp, 'spawnSync', () => { throw new Error('No process allowed'); });
  const http = t.mock.method((require('node:http') as typeof import('node:http')), 'request', () => { throw new Error('No network allowed'); });
  assert.equal(audit(f.options).exitCode, 0);
  for (const mock of [...mocks, proc, http]) mock.mock.restore();
  assert.deepEqual(snapshot(f.base), before);
});

test('help/plan never read targets, and unsafe paths/unknown options reject before access', (t) => {
  for (const args of [[], ['--manifest', '../bad.json'], ['--manifest', 'C:/bad'], ['--manifest', 'con.json'],
    ['--manifest', 'generation-manifest.json', '--source', 'data/../bad'], ['--manifest', 'generation-manifest.json', '--apply']]) assert.throws(() => parse(args));
  t.mock.method(console, 'log', () => {});
  t.mock.method(fs, 'readFileSync', () => { throw new Error('Unexpected read'); });
  t.mock.method(fs, 'realpathSync', () => { throw new Error('Unexpected path resolution'); });
  for (const flag of ['--help', '--plan']) assert.equal(main(['--root', 'not-existing', '--manifest', 'bad', flag]), 0);
});

test('manifest expected hash is verified and empty manifests never mean completed delivery', (t) => {
  const f = fixture(t);
  assert.equal(audit({ ...f.options, expectManifestSha256: 'f'.repeat(64) }).exitCode, 1);
  f.put('generation-manifest.json', []);
  fs.unlinkSync(path.join(f.candidateRoot, 'records', `${f.record.candidateId}.json`));
  const result = audit({ ...f.options, decisions: undefined });
  assert.equal(result.structure.status, 'passed');
  assert.equal(result.exitCode, 3);
});
