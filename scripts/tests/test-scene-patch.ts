'use strict';
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { test }: typeof import('node:test') = require('node:test');
const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const os: typeof import('node:os') = require('node:os');
const zlib: typeof import('node:zlib') = require('node:zlib');
const patch: typeof import('../maintenance/apply-scene-patch') = require('../maintenance/apply-scene-patch');

function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huiyu-scene-patch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function write(file: any, data: any) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data)); }
const pinned = { sc001: { prompt: 'locked' } };
test('scene patch: isolated CLI dry-run only writes explicitly requested report', t => {
  const root = fixture(t), input = sources(root);
  input.forEach(doc => write(doc.file, doc.data));
  write(path.join(root, 'data/prompt-pinned-scenes.json'), { scenes: pinned });
  const script = path.join(root, 'scripts/maintenance/apply-scene-patch.js');
  write(script, fs.readFileSync(require.resolve('../maintenance/apply-scene-patch'), 'utf8'));
  write(path.join(root, 'scripts/lib/data-version.js'), 'exports.syncDataVersion = () => { throw new Error("unexpected rebuild"); };');
  write(path.join(root, 'scripts/lib/runtime-errors.js'), 'exports.errorMessage = error => error && error.message ? String(error.message) : String(error);');
  write(path.join(root, 'scripts/lib/scene-store.js'), `module.exports = { loadSceneShards: () => ({sources: [{source: ${JSON.stringify(input[0].file)}}]}), aggregatePath: ${JSON.stringify(path.join(root, 'data/scenes.json'))}, browserShardPath: {}, corePath: ${JSON.stringify(path.join(root, 'data/core.json'))}, indexPath: ${JSON.stringify(path.join(root, 'data/index.json'))} };`);
  write(path.join(root, 'scripts/lib/blueprint-store.js'), `module.exports = { loadBlueprintShards: () => ({sources: [{source: ${JSON.stringify(input[1].file)}}]}), aggregatePath: ${JSON.stringify(path.join(root, 'data/blueprints.json'))} };`);
  const patchFile = path.join(root, 'patch.json'), output = path.join(root, 'report.json');
  write(patchFile, [{ type: 'scene', id: 'sc001', changes: { story: 'candidate' } }]);
  const snapshot = () => fs.readdirSync(root, { recursive: true }).filter(file => fs.statSync(path.join(root, String(file))).isFile()).map(file => [String(file), fs.readFileSync(path.join(root, String(file))).toString('base64')]);
  const before = snapshot();
  const run = (extra: any) => (require('node:child_process') as typeof import('node:child_process')).spawnSync(process.execPath, [script, '--patch', patchFile, ...extra], { cwd: root, env: { ...process.env, AICS_DATA_ROOT: root }, encoding: 'utf8' });
  const dry = run([]); assert.equal(dry.status, 0, dry.stderr); assert.deepEqual(snapshot(), before);
  const reportRun = run(['--out', output]); assert.equal(reportRun.status, 0, reportRun.stderr);
  const report = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(report.dryRun, true); assert.equal(report.changed, 1); assert.equal(report.schemaVersion, 1);
  assert.deepEqual(snapshot().filter(([file]: any) => file !== 'report.json'), before);
  const rejected = run(['--out', input[0].file + '.gz']); assert.equal(rejected.status, 1);
  assert.deepEqual(snapshot().filter(([file]: any) => file !== 'report.json'), before);
  const failed = run(['--apply', '--out', output]); assert.equal(failed.status, 1);
  const failureReport = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(failureReport.writeStatus, 'rolled-back'); assert.equal(failureReport.rollbackCapability.restored, true);
  assert.equal(JSON.parse(fs.readFileSync(input[0].file, 'utf8'))[0].story, 'old');
});
test('scene patch: output rejects data, compressed siblings and parent aliases', t => {
  const root = fixture(t), input = path.join(root, 'input.json');
  write(input, []);
  for (const output of [input, input + '.gz', input + '.br', path.join(root, 'data/new.json')]) assert.throws(() => patch.validateOutput(output, [input], root), /不得覆盖/);
  const alias = path.join(root, 'alias');
  fs.symlinkSync(root, alias, 'junction');
  assert.throws(() => patch.validateOutput(path.join(alias, 'input.json'), [input], root), /不得覆盖/);
  patch.validateOutput(path.join(root, 'reports/plan.json'), [input], root);
});
test('scene patch: change set report is additive and planning writes no files', t => {
  const root = fixture(t), input = sources(root), entries = [{ type: 'scene', id: 'sc001', changes: { story: 'reviewed' } }];
  const plan = patch.planPatches(input, entries, pinned);
  const options = { sources: input, entries, pinned, derivedFiles: ['aggregate.json'], apply: false, outcome: { applied: false, outcome: 'dry-run' } };
  const report = patch.changeSetReport(plan, options);
  assert.equal(report.schemaVersion, 1); assert.equal(report.changedRecords.length, 1);
  assert.deepEqual(report.protectedFieldDecision.pinnedIds, ['sc001']);
  assert.equal(report.applyStatus.applied, false); assert.equal(report.writeStatus, 'dry-run');
  assert.equal(report.rollbackCapability.backup, null);
  assert.deepEqual(fs.readdirSync(root), []);
  assert.throws(() => patch.changeSetReport(plan, { ...options, pinned: null }));
  assert.throws(() => patch.changeSetReport(plan, { ...options, entries: [{}] }));
});
test('scene patch: rebuild failure restores source compression and readable backup bytes', t => {
  const root = fixture(t), input = sources(root);
  input.forEach(doc => write(doc.file, doc.data));
  const file = input[0].file;
  fs.writeFileSync(file + '.gz', zlib.gzipSync(fs.readFileSync(file)));
  fs.writeFileSync(file + '.br', zlib.brotliCompressSync(fs.readFileSync(file)));
  const original = patch.snapshotFiles([file, file + '.gz', file + '.br']);
  const plan = patch.planPatches(input, [{ type: 'scene', id: 'sc001', changes: { story: 'changed' } }], pinned);
  assert.throws(() => patch.commitPlan(plan, { root, derivedFiles: [], rebuild() { fs.writeFileSync(file + '.gz', 'broken'); throw new Error('rebuild failed'); }, validate() { assert.fail('validation reached'); } }), /已回滚/);
  original.forEach(item => assert.deepEqual(fs.readFileSync(item.file), item.content));
  const directory = path.join(root, 'runtime/maintenance-backups');
  const backup = path.join(directory, fs.readdirSync(directory)[0]);
  const manifest = JSON.parse(fs.readFileSync(path.join(backup, 'manifest.json'), 'utf8'));
  for (const item of manifest.files.filter((item: any) => item.existed)) assert.deepEqual(fs.readFileSync(path.join(backup, 'files', item.backup)), fs.readFileSync(path.join(root, item.source)));
});
function sources(root: any) {
  return [
    { type: 'scene', file: path.join(root, 'data/scenes/shared.json'), data: [{ id: 'sc001', prompt: 'locked', story: 'old' }, { id: 'sc002', prompt: 'ordinary' }] },
    { type: 'blueprint', file: path.join(root, 'data/blueprints/example.json'), data: { version: 2, franchise: 'example', extra: 'preserved', blueprints: [{ id: 'example_scene', title: 'original', promptProse: 'unchanged prose' }] } },
  ];
}

test('scene patch: missing, malformed and empty pinned baselines fail closed', t => {
  const root = fixture(t), file = path.join(root, 'pinned.json');
  assert.throws(() => patch.loadPinnedScenes(file), /定稿保护基线不可读取/);
  write(file, '{invalid');
  assert.throws(() => patch.loadPinnedScenes(file), /定稿保护基线不可读取/);
  for (const value of [{}, { scenes: {} }, { scenes: [] }, { scenes: { sc001: null } }]) {
    write(file, value);
    assert.throws(() => patch.loadPinnedScenes(file), /定稿保护基线结构无效/);
  }
  write(file, { scenes: pinned });
  assert.deepEqual(patch.loadPinnedScenes(file), pinned);
});

test('scene patch: all six protected fields reject the entire mixed patch', t => {
  const input = sources(fixture(t)), original = JSON.stringify(input);
  for (const field of patch.PROTECTED_SCENE_FIELDS) {
    assert.throws(() => patch.planPatches(input, [
      { type: 'scene', id: 'sc002', changes: { story: 'candidate' } },
      { type: 'scene', id: 'sc001', changes: { [field]: 'changed', auditRevision: 'must not be stamped' } },
    ], pinned), /受保护字段禁止批量修改/);
  }
  assert.equal(JSON.stringify(input), original);
});

test('scene patch: metadata-only patch to a pinned scene does not alter protected fields', t => {
  const input = sources(fixture(t));
  const plan = patch.planPatches(input, [{ type: 'scene', id: 'sc001', changes: { story: 'reviewed metadata' } }], pinned);
  assert.equal(plan.writes[0].data[0].prompt, 'locked');
  assert.equal(plan.writes[0].data[0].story, 'reviewed metadata');
  assert.equal((input[0].data as Record<string, any>)[0].story, 'old');
});

test('scene patch: invalid types, IDs, duplicate entries and prototype fields are rejected', () => {
  const item = { type: 'scene', id: 'sc002', changes: { story: 'text' } };
  for (const entries of [{}, [null], [{ ...item, type: 'other' }], [{ ...item, id: '../escape' }], [{ ...item, changes: [] }], [item, item], [{ ...item, changes: { id: 'sc003' } }], JSON.parse('[{"type":"scene","id":"sc002","changes":{"__proto__":{"polluted":true}}}]')]) {
    assert.throws(() => patch.validatePatch(entries));
  }
  assert.equal(({} as any).polluted, undefined);
});

test('scene patch: absent source IDs reject the whole plan without modifying input', t => {
  const input = sources(fixture(t)), original = JSON.stringify(input);
  assert.throws(() => patch.planPatches(input, [{ type: 'blueprint', id: 'missing', changes: { title: 'x' } }], pinned), /记录不存在/);
  assert.equal(JSON.stringify(input), original);
});

test('scene patch: blueprint changes survive aggregate reconstruction from canonical shards', t => {
  const root = fixture(t), input = sources(root);
  input.forEach(doc => write(doc.file, doc.data));
  const aggregate = path.join(root, 'data/scene-blueprints.json');
  write(aggregate, { version: 2, blueprints: [{ id: 'example_scene', title: 'STALE AGGREGATE' }] });
  const plan = patch.planPatches(input, [{ type: 'blueprint', id: 'example_scene', changes: { title: 'reviewed' } }], pinned);
  const rebuild = () => {
    const canonical = JSON.parse(fs.readFileSync(input[1].file, 'utf8'));
    write(aggregate, { version: 2, blueprints: canonical.blueprints });
    return 42;
  };
  const result = patch.commitPlan(plan, { root, derivedFiles: [aggregate], rebuild, validate() {
    assert.equal(JSON.parse(fs.readFileSync(aggregate, 'utf8')).blueprints[0].title, 'reviewed');
  } });
  assert.equal(result.applied, true);
  assert.equal(result.version, 42);
  rebuild();
  const canonical = JSON.parse(fs.readFileSync(input[1].file, 'utf8'));
  assert.equal(canonical.extra, 'preserved');
  assert.equal(canonical.blueprints[0].promptProse, 'unchanged prose');
  assert.equal(JSON.parse(fs.readFileSync(aggregate, 'utf8')).blueprints[0].title, 'reviewed');
});

test('scene patch: validation failure restores canonical, aggregate, version and compressed bytes', t => {
  const root = fixture(t), input = sources(root);
  input.forEach(doc => write(doc.file, doc.data));
  const aggregate = path.join(root, 'data/scene-blueprints.json'), version = path.join(root, 'src/stores/sceneStore.ts');
  write(aggregate, { original: true }); write(version, 'export const DATA_VERSION = 1');
  fs.writeFileSync(aggregate + '.gz', zlib.gzipSync(fs.readFileSync(aggregate)));
  fs.writeFileSync(aggregate + '.br', zlib.brotliCompressSync(fs.readFileSync(aggregate)));
  const files = [input[1].file, aggregate, aggregate + '.gz', aggregate + '.br', version];
  const original = files.map(file => fs.readFileSync(file));
  const plan = patch.planPatches(input, [{ type: 'blueprint', id: 'example_scene', changes: { title: 'candidate' } }], pinned);
  assert.throws(() => patch.commitPlan(plan, { root, derivedFiles: [aggregate, version], rebuild() {
    write(aggregate, { candidate: true }); write(version, 'export const DATA_VERSION = 2'); return 2;
  }, validate() { throw new Error('simulated contract failure'); } }), /已回滚/);
  files.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), original[index]));
});

test('scene patch: rollback removes derived files that did not previously exist', t => {
  const root = fixture(t), input = sources(root);
  input.forEach(doc => write(doc.file, doc.data));
  const aggregate = path.join(root, 'data/scene-blueprints.json');
  const plan = patch.planPatches(input, [{ type: 'blueprint', id: 'example_scene', changes: { title: 'candidate' } }], pinned);
  assert.throws(() => patch.commitPlan(plan, { root, derivedFiles: [aggregate], rebuild() {
    write(aggregate, { candidate: true }); return 2;
  }, validate() { throw new Error('simulated failure'); } }), /已回滚/);
  assert.equal(fs.existsSync(aggregate), false);
  assert.equal(JSON.parse(fs.readFileSync(input[1].file, 'utf8')).blueprints[0].title, 'original');
});

test('scene patch: dry/no-op plans do not write data or create backups', t => {
  const root = fixture(t), input = sources(root);
  const plan = patch.planPatches(input, [{ type: 'blueprint', id: 'example_scene', changes: { title: 'original' } }], pinned);
  assert.equal(plan.writes.length, 0);
  const result = patch.commitPlan(plan, { root, derivedFiles: [], rebuild() { assert.fail('unexpected rebuild'); }, validate() { assert.fail('unexpected validation'); } });
  assert.equal(result.outcome, 'unchanged');
  assert.equal(fs.existsSync(path.join(root, 'runtime')), false);
});

test('scene patch: parser rejects unknown or missing arguments and defaults to dry-run', () => {
  assert.equal(patch.parseArgs(['--patch', 'p.json']).apply, false);
  assert.equal(patch.parseArgs(['--patch', 'p.json', '--apply']).apply, true);
  assert.throws(() => patch.parseArgs(['--patch']), /缺少/);
  assert.throws(() => patch.parseArgs(['--force']), /未知参数/);
});
