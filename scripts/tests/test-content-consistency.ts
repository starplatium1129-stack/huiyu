'use strict';
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const cp: typeof import('node:child_process') = require('node:child_process');
const { test }: typeof import('node:test') = require('node:test');
const { reportOwnership }: typeof import('../maintenance/report-content-ownership') = require('../maintenance/report-content-ownership');
const { localReader }: typeof import('../lib/content-history-reader') = require('../lib/content-history-reader');
const { inspectDomain, summarizeConsistency }: typeof import('../lib/content-impact-consistency') = require('../lib/content-impact-consistency');
const { fixture, snapshot }: typeof import('./content-history-fixture') = require('./content-history-fixture');
const inspect = (f: { root: unknown; base?: string|null; write?: (file: string,value: string|Uint8Array<ArrayBufferLike>|Uint8ClampedArray<ArrayBufferLike>|Uint16Array<ArrayBufferLike>|Uint32Array<ArrayBufferLike>|Int8Array<ArrayBufferLike>|Int16Array<ArrayBufferLike>|Int32Array<ArrayBufferLike>|BigUint64Array<ArrayBufferLike>|BigInt64Array<ArrayBufferLike>|Float16Array<ArrayBufferLike>|Float32Array<ArrayBufferLike>|Float64Array<ArrayBufferLike>|DataView<ArrayBufferLike>|({ id: string; char: string; prompt: string; rating: string; mature: boolean; }|undefined)[]|{ id: string; name: string; }[]) => void; read?: (file: string) => unknown; characters?: ({ id: string; identityProse: string; outfits: { id: string; prose: string; default: boolean; isDefault: boolean; }[]; }|{ id: string; identityProse: string; outfits: { id: string; default: boolean; isDefault: boolean; }[]; })[]; blueprints?: ({ id: string; characterId: string; outfitId: string; prompt: string; }|{ id: string; characterId: string; prompt: string; outfitId?: undefined; })[]; scenes?: { id: string; char: string; prompt: string; rating: string; mature: boolean; }[]; sceneProducts?: (rows?: { id: string; char: string; prompt: string; rating: string; mature: boolean; }[],core?: string[]) => void; }, domain: PropertyKey) => summarizeConsistency(inspectDomain(localReader(f.root), domain));
const script = path.resolve(__dirname, '../maintenance/report-content-ownership.js');

test('popular and blueprint record fields/version/order are actual projections, formatting is separate', (t) => {
  const f = fixture(t, false);
  assert.equal(inspect(f, 'popular').status, 'current');
  assert.equal(inspect(f, 'blueprints').status, 'current');
  const value = f.read('data/popular-characters.json');
  f.write('data/popular-characters.json', JSON.stringify(value));
  const formatted = inspect(f, 'popular');
  assert.equal(formatted.status, 'current');
  assert.equal(formatted.checks[0].serialization, 'different');
  value.characters.reverse();
  f.write('data/popular-characters.json', value);
  assert.equal(inspect(f, 'popular').status, 'mismatch');
  value.characters.reverse();
  value.version = 2;
  f.write('data/popular-characters.json', value);
  assert.equal(inspect(f, 'popular').status, 'mismatch');
});

test('scene group placement, numeric sc1000 ordering, core and index projections are checked without builders', (t) => {
  const f = fixture(t, false);
  const current = inspect(f, 'scenes');
  assert.equal(current.status, 'current');
  assert.equal(current.checks.length, 6);
  f.write('data/scenes-nene.json', [f.scenes[1]]);
  f.write('data/scenes-core.json', [f.scenes[2]]);
  const index = f.read('data/scenes-index.json');
  index.total = 999;
  index.orderedIds.reverse();
  f.write('data/scenes-index.json', index);
  const result = inspect(f, 'scenes');
  assert.equal(result.status, 'mismatch');
  for (const file of ['data/scenes-nene.json', 'data/scenes-core.json', 'data/scenes-index.json']) assert.ok(result.issues.some((r: { file: string; }) => r.file === file));
});

test('changed curation updates expected core order; source gaps and orphan batches invalidate proof', (t) => {
  const f = fixture(t, false);
  f.write('data/curation.json', { curatedSceneIds: [], signatureSceneIds: [], personaCoreSceneIds: ['sc1000', 'sc001'] });
  assert.equal(reportOwnership({ root: f.root, domain: 'curation', consistency: true }).domains[0].consistency.status, 'mismatch');
  fs.renameSync(path.join(f.root, 'data/scenes/one.2.json'), path.join(f.root, 'data/scenes/one.3.json'));
  const result = inspect(f, 'scenes');
  assert.equal(result.status, 'unknown');
  assert.ok(result.unknown.some((r: string|string[]) => r.includes('batch gap')));
  assert.ok(!result.checks.some((r: { status: string; }) => r.status === 'current'));
});

test('reference identity/default/prose/perspective fields are mirrored; pending and URLs stay unverified', (t) => {
  const f = fixture(t, false);
  const result = inspect(f, 'references');
  assert.equal(result.status, 'current');
  assert.ok(result.checks[0].untracked.some((r: string|string[]) => r.includes('URL')));
  const view = f.read('data/character-reference-view.json');
  view.a.identityProse = 'stale identity';
  view.a.outfits[0].isDefault = false;
  view.a.outfits[0].references[0].lens = 'wrong lens';
  view.a.outfits[0].references[0].url = '/outside/never-read.png';
  f.write('data/character-reference-view.json', view);
  const mismatch = inspect(f, 'references');
  assert.equal(mismatch.status, 'mismatch');
  for (const suffix of ['/identityProse', '/isDefault', '/lens']) assert.ok(mismatch.issues.some((r: { location: string; }) => r.location.endsWith(suffix)));
  assert.ok(!mismatch.issues.some((r: { location: string|string[]; }) => r.location.includes('url')));
});

test('duplicate IDs, malformed records and untracked field domains cannot produce consistency PASS', (t) => {
  const f = fixture(t, false);
  f.characters.push({ ...f.characters[0] });
  f.write('data/popular/one.json', { characters: f.characters });
  f.write('data/popular-characters.json', { version: 1, characters: f.characters });
  f.write('data/popular/manifest.json', { files: [{ file: 'one.json', count: 4 }] });
  assert.equal(inspect(f, 'popular').status, 'mismatch');
  const view = f.read('data/character-reference-view.json');
  view.a.outfits[0].references = 'not-an-array';
  f.write('data/character-reference-view.json', view);
  assert.equal(inspect(f, 'references').status, 'unknown');
  const profiles = reportOwnership({ root: f.root, domain: 'characters', consistency: true }).domains[0];
  assert.equal(profiles.consistency.status, 'unknown');
  assert.equal(profiles.fieldContract.status, 'unknown');
});

test('ownership consistency CLI/help and source/derived comparisons leave fixture bytes unchanged', (t) => {
  const f = fixture(t, false);
  const before = snapshot(f.root);
  for (const domain of ['popular', 'scenes', 'blueprints', 'references', 'curation']) {
    const output = cp.spawnSync(process.execPath, [script, '--root', f.root, '--domain', domain, '--consistency', '--json'], { encoding: 'utf8' });
    assert.equal(output.status, 0, output.stderr || output.stdout);
    const result = JSON.parse(output.stdout).domains[0];
    assert.equal(result.consistency.status, 'current');
    assert.ok(result.fieldContract.implementation.length);
  }
  assert.deepEqual(snapshot(f.root), before);
  for (const flag of ['--help', '--plan']) {
    assert.equal(cp.spawnSync(process.execPath, [script, '--root', 'not-existing', '--consistency', flag]).status, 0);
  }
  f.write('data/scenes-index.json', { total: 999 });
  const output = cp.spawnSync(process.execPath, [script, '--root', f.root, '--domain', 'scenes', '--consistency', '--json'], { encoding: 'utf8' });
  assert.equal(output.status, 1);
  assert.equal(JSON.parse(output.stdout).domains[0].consistency.status, 'mismatch');
});

test('snapshot evidence detects changed input during read instead of certifying a mixed snapshot', (t) => {
  const f = fixture(t, false);
  const reader = localReader(f.root);
  reader.json('data/characters.json');
  f.write('data/characters.json', [{ id: 'different' }]);
  assert.deepEqual(reader.verify(), ['data/characters.json: changed during snapshot read']);
});

test('snapshot evidence also invalidates directory membership changes and missing-file additions', (t) => {
  const f = fixture(t, false);
  const reader = localReader(f.root);
  reader.list('data/blueprints');
  assert.equal(reader.read('data/blueprints/new.json').status, 'missing');
  f.write('data/blueprints/new.json', { blueprints: [] });
  const errors = reader.verify();
  assert.ok(errors.includes('data/blueprints: directory membership changed during snapshot read'));
  assert.ok(errors.includes('data/blueprints/new.json: changed during snapshot read'));
});
