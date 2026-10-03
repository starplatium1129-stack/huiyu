import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
const { getSpecsForLane, loadLaneManifest }: typeof import('./run-e2e-lane') = require('./run-e2e-lane');

const root = path.resolve(__dirname, '../..');

test('browser inventory covers each spec once and automated lanes exclude manual/device probes', () => {
  const manifest = loadLaneManifest();
  const discovered = fs.readdirSync(path.join(root, 'tests/e2e')).filter(file => file.endsWith('.spec.ts')).sort();
  const names = manifest.specs.map(spec => spec.file);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(new Set(names).size, names.length, 'duplicate browser registration');
  assert.deepEqual([...names].sort(), discovered, 'missing or obsolete browser registration');
  for (const spec of manifest.specs) {
    assert.ok(['critical', 'nightly', 'manual', 'device'].includes(spec.lane) && spec.risk.trim() && spec.reason.trim(), spec.file);
  }
  const critical = getSpecsForLane('critical'), nightly = getSpecsForLane('nightly');
  assert.ok(critical.length > 0 && nightly.length > 0);
  assert.deepEqual(getSpecsForLane('all'), [...critical, ...nightly].sort());
  for (const lane of ['critical', 'nightly', 'manual', 'device']) {
    assert.deepEqual(getSpecsForLane(lane), manifest.specs.filter(spec => spec.lane === lane).map(spec => spec.file).sort());
  }
  assert.deepEqual(critical.filter(file => nightly.includes(file)), []);
  for (const lane of ['manual', 'device']) {
    assert.deepEqual(getSpecsForLane(lane).filter(file => getSpecsForLane('all').includes(file)), []);
  }
  assert.ok(getSpecsForLane('device').includes('studio-live2d.spec.ts'), 'bundled model loading requires explicit device acceptance');
  assert.deepEqual(getSpecsForLane('unknown'), []);
});

test('nightly screenshots are uploaded from the hidden review directory without silent loss', () => {
  const root = path.resolve(__dirname, '..', '..');
  const nightly = fs.readFileSync(path.join(root, '.github', 'workflows', 'nightly-e2e.yml'), 'utf8');
  const uploads = nightly.split(/\r?\n(?= {6}- )/).filter(step => /uses:\s+actions\/upload-artifact@/.test(step)
    && /^\s+path:\s+\.review-shots\/\*\.png\s*$/m.test(step));
  assert.equal(uploads.length, 1, 'nightly must have one dedicated review screenshot upload');
  const upload = uploads[0];
  assert.ok(upload, 'nightly must keep the dedicated screenshot upload step');
  assert.match(upload, /^\s+if:\s+always\(\)\s*$/m,
    'screenshots must remain available when another visual assertion fails');
  assert.match(upload, /^\s+path:\s+\.review-shots\/\*\.png\s*$/m,
    'hidden-file opt-in must be scoped to generated review PNGs');
  assert.match(upload, /^\s+include-hidden-files:\s+true\s*$/m,
    'upload-artifact otherwise excludes the hidden .review-shots directory');
  assert.match(upload, /^\s+if-no-files-found:\s+error\s*$/m,
    'missing screenshot evidence must fail instead of silently reporting success');
});

test('exact browser selections start only required isolated stacks, unknown filters stay conservative', () => {
  const { selectE2eServers, selectE2eSpecs }: typeof import('../lib/e2e-selection') = require('../lib/e2e-selection');
  const { loadLaneManifest }: typeof import('./run-e2e-lane') = require('./run-e2e-lane');
  const known = loadLaneManifest().specs.map(spec => spec.file);
  assert.deepStrictEqual(selectE2eServers(['test', 'tests/e2e/studio.spec.ts', '--project', 'desktop', '--grep', 'flows.spec.ts'], known), ['web']);
  assert.deepStrictEqual(selectE2eServers(['test', 'tests\\e2e\\flows.spec.ts:10', '--project=flows'], known), ['gateway']);
  assert.deepStrictEqual(selectE2eServers(['test', 'studio.spec.ts', 'flows.spec.ts'], known), ['web', 'gateway']);
  assert.deepStrictEqual(selectE2eServers(['test', 'interaction-polish.spec.ts'], known), ['web', 'gateway']);
  for (const args of [[], ['test', 'studio'], ['test', 'unknown.spec.ts'], ['test', '--project=desktop'],
    ['test', 'studio.spec.ts', '--test-list=selection.txt'], ['test', '--project=*']]) {
    assert.deepStrictEqual(selectE2eServers(args, known), ['web', 'gateway'], args.join(' '));
  }
  assert.deepStrictEqual(selectE2eServers(['test', '--project', 'flows'], known), ['gateway']);
  const specs = loadLaneManifest().specs;
  const automated = specs.filter(spec => ['critical', 'nightly'].includes(spec.lane)).map(spec => spec.file);
  assert.deepEqual(selectE2eSpecs(['test'], specs), automated);
  for (const args of [['test', '--project=desktop', '--grep', 'manual'],
    ['test', '--trace', 'on', '--global-timeout', '30000'], ['test', '--project', 'desktop', 'flows'],
    ['test', '--test-list-invert', 'excluded.txt'], ['test', '--only-changed', 'HEAD']]) {
    assert.deepEqual(selectE2eSpecs(args, specs), automated, args.join(' '));
  }
  for (const args of [['test', 'desktop-ux.spec.ts'], ['test', 'atelier-design'], ['test', '--test-list=selection.txt']]) {
    assert.deepEqual(selectE2eSpecs(args, specs), known, 'explicit acceptance selections preserve manual/device access');
  }
});

test('desktop specs addressing the gateway keep their explicit stack prerequisite', () => {
  const { MOCK_SPECS, GATEWAY_SPECS }: typeof import('../lib/e2e-selection') = require('../lib/e2e-selection');
  const root = path.resolve(__dirname, '..', '..');
  const { loadLaneManifest }: typeof import('./run-e2e-lane') = require('./run-e2e-lane');
  for (const { file } of loadLaneManifest().specs) {
    if (MOCK_SPECS.test(file)) continue;
    const source = fs.readFileSync(path.join(root, 'tests/e2e', file), 'utf8');
    if (/MOCK_PORTS\.gateway/.test(source)) assert.ok(GATEWAY_SPECS.has(file), `${file} requires the isolated gateway stack`);
  }
});
