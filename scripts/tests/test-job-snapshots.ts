'use strict';

import assert = require('node:assert/strict');
import { test, type TestContext } from 'node:test';
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import jobSnapshot = require('../../server/job-snapshot');
const { createJobSnapshotStore, toSnapshot, safeId } = jobSnapshot;

function tempDir(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-job-snap-'));
  t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
  return dir;
}
function sampleJob(overrides: Record<string, unknown> = {}) {
  return Object.assign({ id:'v-1730000000-ab12', owner:'local', createdAt:1730000000000,
    estimatedSeconds:180, input:{ modelId:'h3-native', width:832, height:480, duration:5 } }, overrides);
}

test('save writes only public fields, without prompts or tokens', t => {
  const dir = tempDir(t), store = createJobSnapshotStore(dir);
  store.save(sampleJob({ prompt:'private prompt', token:'private token' }));
  const names = fs.readdirSync(dir);
  assert.equal(names.length, 1);
  const parsed = JSON.parse(fs.readFileSync(path.join(dir, names[0]), 'utf8'));
  assert.equal(parsed.id, 'v-1730000000-ab12');
  assert.equal(parsed.status, 'running');
  assert.deepEqual(Object.keys(parsed.input), ['modelId', 'width', 'height', 'duration']);
  assert.ok(!JSON.stringify(parsed).includes('private'));
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, names[0])).mode & 0o777, 0o600);
});

test('loss records survive repeated process/store restarts without renewing retention', t => {
  const dir = tempDir(t), store = createJobSnapshotStore(dir);
  store.save(sampleJob()); store.save(sampleJob({ id:'v-second' }));
  assert.equal(store.drain().length, 2);
  const file = path.join(dir, 'v-second.json');
  const first = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(first.lostAt > 0);
  const restored = createJobSnapshotStore(dir).drain();
  assert.equal(restored.length, 2);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).lostAt, first.lostAt);
  assert.ok(!Object.hasOwn(restored[0], 'lostAt'), 'internal retention metadata stays off the route contract');
});

test('remove deletes only the exact owned record', t => {
  const dir = tempDir(t), store = createJobSnapshotStore(dir);
  store.save(sampleJob()); store.save(sampleJob({ id:'v-other' })); store.remove('v-other');
  assert.deepEqual(store.drain().map(s => s.id), ['v-1730000000-ab12']);
  store.remove('v-1730000000-ab12');
  assert.deepEqual(createJobSnapshotStore(dir).drain(), []);
});

test('corrupt and unrecognized files are rejected but preserved for diagnosis', t => {
  const dir = tempDir(t), store = createJobSnapshotStore(dir);
  fs.writeFileSync(path.join(dir, 'broken.json'), '{not-json');
  fs.writeFileSync(path.join(dir, 'x.json'), JSON.stringify({ foo:1 }));
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'keep');
  store.save(sampleJob());
  const warnings: unknown[][] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => warnings.push(args));
  assert.equal(store.drain().length, 1);
  assert.equal(store.drain().length, 1);
  assert.equal(warnings.length, 1, 'one warning per problem class, not per poll/file');
  assert.equal(fs.readFileSync(path.join(dir, 'broken.json'), 'utf8'), '{not-json');
  assert.equal(fs.readFileSync(path.join(dir, 'notes.txt'), 'utf8'), 'keep');
});

test('restore requires matching filename, status and a valid owner', t => {
  const dir = tempDir(t);
  t.mock.method(console, 'warn', () => {});
  const cases = [
    { ...sampleJob(), id:'other', status:'running' },
    { ...sampleJob(), id:'b', status:'succeeded' },
    { ...sampleJob(), id:'c', status:'running', owner:{} },
    { ...sampleJob(), id:'d', status:'running', owner:'bad\nowner' },
  ];
  cases.forEach((value, i) => fs.writeFileSync(path.join(dir, ['a','b','c','d'][i] + '.json'), JSON.stringify(value)));
  assert.deepEqual(createJobSnapshotStore(dir).drain(), []);
  assert.equal(fs.readdirSync(dir).length, 4);
});

test('IDs are rejected, never lossy-normalized into another record', t => {
  assert.equal(safeId('../../etc/passwd'), '');
  assert.equal(safeId('v-1_2.3-x'), 'v-1_2.3-x');
  for (const id of ['../safe', 'a/b', '..\\safe', '.', '..', 'x'.repeat(81), null, {}]) assert.equal(safeId(id), '');
  const dir = tempDir(t), store = createJobSnapshotStore(dir);
  t.mock.method(console, 'warn', () => {});
  store.save(sampleJob({ id:'safe' }));
  store.save(sampleJob({ id:'../safe', owner:'other' }));
  store.remove('../safe');
  assert.equal(store.drain()[0].owner, 'local');
  assert.equal(fs.readdirSync(dir).length, 1);
});

test('toSnapshot and restore apply the same field/type whitelist', t => {
  const dir = tempDir(t);
  const snap = toSnapshot(sampleJob());
  assert.deepEqual(Object.keys(snap), ['id', 'owner', 'status', 'createdAt', 'estimatedSeconds', 'input']);
  fs.writeFileSync(path.join(dir, 'untrusted.json'), JSON.stringify({ ...sampleJob(), id:'untrusted', status:'running',
    token:'secret', prompt:'secret', input:{ modelId:{ secret:true }, width:-1, height:'480', duration:5, prompt:'secret' } }));
  const restored = createJobSnapshotStore(dir).drain();
  assert.deepEqual(restored[0].input, { modelId:null, width:null, height:null, duration:5 });
  assert.ok(!JSON.stringify(restored).includes('secret'));
  assert.ok(!fs.readFileSync(path.join(dir, 'untrusted.json'), 'utf8').includes('secret'));
});

test('loss records expire after seven days, measured from first loss detection', t => {
  const dir = tempDir(t), now = Date.now();
  fs.writeFileSync(path.join(dir, 'old.json'), JSON.stringify({ ...toSnapshot(sampleJob({ id:'old' })), lostAt:now - 8 * 86400000 }));
  fs.writeFileSync(path.join(dir, 'fresh.json'), JSON.stringify({ ...toSnapshot(sampleJob({ id:'fresh' })), lostAt:now - 86400000 }));
  assert.deepEqual(createJobSnapshotStore(dir).drain().map(s => s.id), ['fresh']);
  assert.equal(fs.existsSync(path.join(dir, 'old.json')), false);
});

test('restored loss registry and retained files are bounded to 256 valid records', t => {
  const dir = tempDir(t), now = Date.now();
  for (let i = 0; i < 260; i++) fs.writeFileSync(path.join(dir, `v-${i}.json`),
    JSON.stringify({ ...toSnapshot(sampleJob({ id:`v-${i}` })), lostAt:now - i * 1000 }));
  const restored = createJobSnapshotStore(dir).drain();
  assert.equal(restored.length, 256);
  assert.equal(fs.readdirSync(dir).length, 256);
  assert.equal(restored[0].id, 'v-0');
  assert.ok(!restored.some(s => s.id === 'v-259'));
});

test('oversized JSON and directories are never read or removed as snapshots', t => {
  const dir = tempDir(t);
  t.mock.method(console, 'warn', () => {});
  fs.writeFileSync(path.join(dir, 'large.json'), ' '.repeat(20 * 1024));
  fs.mkdirSync(path.join(dir, 'nested.json'));
  const store = createJobSnapshotStore(dir);
  assert.deepEqual(store.drain(), []);
  store.remove('nested');
  assert.ok(fs.statSync(path.join(dir, 'nested.json')).isDirectory());
  assert.equal(fs.statSync(path.join(dir, 'large.json')).size, 20 * 1024);
});

test('snapshot links and linked store directories are not followed', { skip:process.platform === 'win32' }, t => {
  const dir = tempDir(t), outside = tempDir(t);
  t.mock.method(console, 'warn', () => {});
  const target = path.join(outside, 'linked.json');
  const original = JSON.stringify(toSnapshot(sampleJob({ id:'linked' })));
  fs.writeFileSync(target, original);
  fs.symlinkSync(target, path.join(dir, 'linked.json'));
  const store = createJobSnapshotStore(dir);
  assert.deepEqual(store.drain(), []); store.remove('linked');
  assert.equal(fs.readFileSync(target, 'utf8'), original);
  fs.symlinkSync(outside, path.join(dir, 'store'));
  createJobSnapshotStore(path.join(dir, 'store')).save(sampleJob());
  assert.deepEqual(fs.readdirSync(outside), ['linked.json']);
});

test('failed atomic publish cleans temporary files, warns once and preserves prior bytes', t => {
  const dir = tempDir(t), store = createJobSnapshotStore(dir);
  store.save(sampleJob());
  const file = path.join(dir, 'v-1730000000-ab12.json'), before = fs.readFileSync(file);
  const warnings: unknown[][] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => warnings.push(args));
  t.mock.method(fs, 'renameSync', () => { throw new Error('secret path'); });
  assert.doesNotThrow(() => { store.save(sampleJob({ owner:'new' })); store.save(sampleJob({ owner:'new' })); });
  assert.deepEqual(fs.readFileSync(file), before);
  assert.deepEqual(fs.readdirSync(dir), ['v-1730000000-ab12.json']);
  assert.equal(warnings.length, 1);
  assert.ok(!JSON.stringify(warnings).includes('secret path'));
});

test('unconfigured store is a no-op', () => {
  const store = createJobSnapshotStore(undefined);
  store.save(sampleJob()); store.remove('any'); assert.deepEqual(store.drain(), []);
});
