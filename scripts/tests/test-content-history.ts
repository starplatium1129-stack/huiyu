'use strict';

import { PathOrFileDescriptor } from 'node:fs';

const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs: typeof import('node:fs') = require('node:fs');
const os: typeof import('node:os') = require('node:os');
const path: typeof import('node:path') = require('node:path');
const cp: typeof import('node:child_process') = require('node:child_process');
const { test }: typeof import('node:test') = require('node:test');
const { parse, report, main }: typeof import('../maintenance/report-content-impact') = require('../maintenance/report-content-impact');
const { collectGitHistory }: typeof import('../maintenance/content-impact-git') = require('../maintenance/content-impact-git');
const { formatImpactReport }: typeof import('../lib/content-impact-format') = require('../lib/content-impact-format');
const { fixture, git, snapshot }: typeof import('./content-history-fixture') = require('./content-history-fixture');
const script = path.resolve(__dirname, '../maintenance/report-content-impact.js');
const run = (f: any, ...args: (string|undefined)[]) => report(parse(['--root', f.root, '--base', f.base, ...args]));
const entity = (result: any, kind: string, id: string, role: any = 'source') => result.history.entities.find((r: { kind: string; id: string; role: string; }) => r.kind === kind && r.id === id && r.role === role);

test('explicit base tracks committed changes, scoped IDs, both owners/outfits and separate source/derived records', (t) => {
  const f = fixture(t);
  const rows = f.read('data/blueprints/one.json');
  rows.blueprints[0] = { ...rows.blueprints[0], characterId: 'b', outfitId: 'coat', prompt: 'changed' };
  f.write('data/blueprints/one.json', rows);
  f.write('data/scene-blueprints.json', { version: 2, ...rows });
  git(f.root, 'add', '--', 'data/blueprints/one.json', 'data/scene-blueprints.json');
  git(f.root, 'commit', '-m', 'new relationships');
  const before = snapshot(f.root);
  const result = run(f);
  assert.equal(result.gitHistory.status, 'compared');
  assert.equal(result.gitHistory.baseCommit, f.base);
  assert.notEqual(result.gitHistory.headCommit, f.base);
  const change = entity(result, 'blueprint', 'bp-a');
  assert.equal(change.change, 'modified');
  assert.ok(change.changedFields.includes('/characterId'));
  assert.ok(change.oldRelations.some((r: { kind: string; characterId: string; id: string; }) => r.kind === 'outfit' && r.characterId === 'a' && r.id === 'dress'));
  assert.ok(change.newRelations.some((r: { kind: string; characterId: string; id: string; }) => r.kind === 'outfit' && r.characterId === 'b' && r.id === 'coat'));
  assert.equal(entity(result, 'blueprint', 'bp-a', 'derived').change, 'modified');
  assert.ok(!result.affected.some((r: { id: string; }) => r.id === 'bp-unrelated'));
  assert.equal(result.incrementalPlan.mode, 'full');
  assert.ok(result.incrementalPlan.incrementalChecks.length > 0);
  assert.equal(result.incrementalPlan.executed, false);
  assert.equal(result.incrementalPlan.wholeLibrary, 'not-validated');
  assert.ok(result.evidence.files.every((r: any) => r.sha256));
  assert.deepEqual(snapshot(f.root), before);
});

test('deleted source records survive in old relationships; unchanged stale aggregate is a mismatch, not a source', (t) => {
  const f = fixture(t);
  const rows = f.read('data/popular/one.json');
  rows.characters = rows.characters.filter((r: { id: string; }) => r.id !== 'a');
  f.write('data/popular/one.json', rows);
  f.write('data/popular/manifest.json', { files: [{ file: 'one.json', count: 2 }] });
  const result = run(f);
  assert.equal(entity(result, 'character', 'a').change, 'removed');
  assert.equal(entity(result, 'outfit', 'dress').change, 'removed');
  assert.ok(result.affected.some((r: { id: string; impact: string; }) => r.id === 'bp-a' && r.impact === 'revalidate'));
  assert.ok(result.mustChange.some((r: any) => r.object === 'data/popular-characters.json'));
  assert.ok(result.mustChange.some((r: any) => r.reason.includes('dangling characterId')));
  assert.ok(!result.mustChange.some((r: any) => r.object.includes('bp-unrelated')));
  assert.ok(!entity(result, 'character', 'a', 'derived'));
});

test('staged rename with changed source uses stable IDs across old/new manifest paths', (t) => {
  const f = fixture(t);
  git(f.root, 'mv', 'data/blueprints/one.json', 'data/blueprints/renamed file.json');
  f.write('data/blueprints/manifest.json', { files: [{ file: 'renamed file.json', count: 3 }] });
  const value = f.read('data/blueprints/renamed file.json');
  value.blueprints[0].prompt = 'renamed and edited';
  f.write('data/blueprints/renamed file.json', value);
  const result = run(f);
  assert.ok(result.gitHistory.changes.some((r: { status: string; oldPath: string; path: string; }) => r.status.startsWith('R') && r.oldPath === 'data/blueprints/one.json' && r.path === 'data/blueprints/renamed file.json'));
  const changed = entity(result, 'blueprint', 'bp-a');
  assert.equal(changed.change, 'modified-and-moved');
  assert.equal(changed.before[0].file, 'data/blueprints/one.json');
  assert.equal(changed.after[0].file, 'data/blueprints/renamed file.json');
  assert.equal(entity(result, 'blueprint', 'bp-unrelated').change, 'moved');
});

test('aggregate-only changes are identified by derived stable ID and preserve source authority', (t) => {
  const f = fixture(t);
  const aggregate = f.read('data/scene-blueprints.json');
  aggregate.blueprints[0].characterId = 'b';
  aggregate.blueprints[0].outfitId = 'coat';
  f.write('data/scene-blueprints.json', aggregate);
  const result = run(f);
  assert.equal(entity(result, 'blueprint', 'bp-a'), undefined);
  assert.equal(entity(result, 'blueprint', 'bp-a', 'derived').change, 'modified');
  assert.ok(result.mustChange.some((r: any) => r.object === 'data/scene-blueprints.json'));
  assert.ok(result.affected.find((r: { id: string; }) => r.id === 'bp-a').sources.some((r: { side: string; }) => r.side === 'working-tree'));
});

test('scene deletion/creation, curation removal and retired additions include sc1000 and old members', (t) => {
  const f = fixture(t);
  f.write('data/scenes/one.1.json', [f.scenes[1]]);
  f.write('data/scenes/one.2.json', [f.scenes[2], { id: 'sc1001', char: 'b', prompt: 'new scene' }]);
  f.write('data/curation.json', { curatedSceneIds: [], signatureSceneIds: [], personaCoreSceneIds: [] });
  f.write('data/retired-scenes.json', { records: [{ id: 'sc001', reason: 'removed' }, { id: 'sc099', reason: 'retired' }] });
  f.sceneProducts([f.scenes[1], f.scenes[2], { id: 'sc1001', char: 'b', prompt: 'new scene' }], []);
  const result = run(f, '--scene', 'sc1000');
  assert.equal(entity(result, 'scene', 'sc001').change, 'removed');
  assert.equal(entity(result, 'scene', 'sc1001').change, 'added');
  assert.equal(entity(result, 'curation', 'sc001').change, 'removed');
  assert.equal(entity(result, 'retired', 'sc001').change, 'added');
  assert.ok(result.affected.some((r: { id: string; }) => r.id === 'sc1000'));
  assert.ok(result.affected.some((r: { id: string; }) => r.id === 'sc001'));
  assert.equal(result.mustChange.length, 0);
});

test('old/new default outfit changes invalidate implicit blueprint dependencies in both snapshots', (t) => {
  const f = fixture(t);
  const rows = f.read('data/popular/one.json');
  for (const outfit of rows.characters[0].outfits) outfit.default = outfit.isDefault = outfit.id === 'coat';
  f.write('data/popular/one.json', rows);
  f.write('data/popular-characters.json', { version: 1, ...rows });
  const result = run(f);
  const affected = result.affected.find((r: { id: string; }) => r.id === 'bp-default');
  assert.ok(affected);
  assert.ok(affected.oldRelations.some((r: { kind: string; id: string; via: string; }) => r.kind === 'outfit' && r.id === 'dress' && r.via === 'proven-default-outfit'));
  assert.ok(affected.newRelations.some((r: { kind: string; id: string; via: string; }) => r.kind === 'outfit' && r.id === 'coat' && r.via === 'proven-default-outfit'));
  for (const id of ['dress', 'coat']) assert.ok(result.affected.some((r: { kind: string; characterId: string; id: string; }) => r.kind === 'outfit' && r.characterId === 'a' && r.id === id));
  assert.ok(!result.affected.some((r: { id: string; }) => r.id === 'bp-unrelated'));
});

test('missing base products, invalid JSON and deleted shard without manifest update stay unknown/full', (t) => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.root, 'data/scene-blueprints.json'));
  git(f.root, 'add', '--', 'data/scene-blueprints.json');
  git(f.root, 'commit', '-m', 'no versioned aggregate');
  f.base = git(f.root, 'rev-parse', 'HEAD');
  f.write('data/scene-blueprints.json', { version: 2, blueprints: f.blueprints });
  fs.unlinkSync(path.join(f.root, 'data/blueprints/one.json'));
  const result = run(f);
  assert.equal(entity(result, 'blueprint', 'bp-a').change, 'unresolved-removal');
  assert.equal(entity(result, 'blueprint', 'bp-a', 'derived').change, 'unresolved-addition');
  assert.ok(result.unknown.some((r: any) => r.includes('base:') && r.includes('missing')));
  assert.equal(result.incrementalPlan.mode, 'full');
  f.write('data/blueprints/one.json', '{');
  assert.ok(run(f).unknown.some((r: any) => r.includes('invalid JSON')));
});

test('unknown paths, manifest order changes and global builders require full, never a partial PASS', (t) => {
  const f = fixture(t);
  f.write('scripts/lib/custom-contract.js', 'throw new Error("must not execute");');
  f.write('data/custom.json', { unknown: true });
  const result = run(f);
  assert.equal(result.incrementalPlan.mode, 'full');
  assert.ok(result.unknown.some((r: any) => r.includes('custom-contract.js')));
  assert.ok(result.unknown.some((r: any) => r.includes('data/custom.json')));
  assert.ok(result.recommendations.every((r: any) => r.executed === false));
  assert.equal(result.incrementalPlan.wholeLibrary, 'not-validated');
});

test('invalid revisions fail before process creation; valid-looking missing commits fail closed', (t) => {
  for (const value of ['--upload-pack=bad', '-bad', 'HEAD:file', 'HEAD..main', 'HEAD^{tree}', 'HEAD@{0}', 'HEAD\nmain', 'HEAD;write', 'HEAD$(write)', 'HEAD\0', '../x']) {
    assert.throws(() => parse(['--base', value]));
    let calls = 0;
    const mock = t.mock.method(cp, 'spawnSync', () => { calls++; throw new Error('must not spawn'); });
    assert.equal(collectGitHistory('not-read', value).result.status, 'error');
    assert.equal(calls, 0);
    mock.mock.restore();
  }
  const f = fixture(t);
  const before = snapshot(f.root);
  const output = cp.spawnSync(process.execPath, [script, '--root', f.root, '--base', 'no-such-local-ref', '--json'], { encoding: 'utf8' });
  assert.equal(output.status, 1);
  assert.equal(JSON.parse(output.stdout).gitHistory.status, 'error');
  assert.deepEqual(snapshot(f.root), before);
});

test('scene parameter accepts canonical IDs only including extended namespace', () => {
  for (const id of ['sc001', 'sc999', 'sc1000', 'sc100000']) assert.equal(parse(['--scene', id]).scene, id);
  for (const id of ['sc000', 'sc01', 'sc0001', 'sc0999', 'sc01000', 'sc-1000', 'SC1000', 'sc1000x', 'sc9007199254740992']) assert.throws(() => parse(['--scene', id]));
});

test('help/plan never read target or spawn; CLI/text report remain zero-write including Git index', (t) => {
  const f = fixture(t);
  f.write('data/blueprints/one.json', { blueprints: f.blueprints.map((r) => r.id === 'bp-a' ? { ...r, prompt: 'edited' } : r) });
  const before = snapshot(f.root);
  for (const json of [true, false]) {
    const output = cp.spawnSync(process.execPath, [script, '--root', f.root, '--base', f.base, ...(json ? ['--json'] : [])], { encoding: 'utf8' });
    assert.equal(output.status, 1); // intentionally stale aggregate
    assert.ok(json ? JSON.parse(output.stdout).readOnly : output.stdout.includes('历史对照'));
  }
  assert.deepEqual(snapshot(f.root), before);
  t.mock.method(console, 'log', () => {});
  t.mock.method(cp, 'spawnSync', () => { throw new Error('Unexpected process'); });
  t.mock.method(fs, 'readFileSync', () => { throw new Error('Unexpected read'); });
  for (const flag of ['--help', '--plan']) assert.equal(main(['--base', 'HEAD', '--root', 'not-existing', flag]), 0);
});

test('junction escape is rejected without reading external data and no write APIs are used', (t) => {
  const f = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'history-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.renameSync(path.join(f.root, 'data/blueprints'), path.join(outside, 'blueprints'));
  fs.symlinkSync(path.join(outside, 'blueprints'), path.join(f.root, 'data/blueprints'), process.platform === 'win32' ? 'junction' : 'dir');
  const before = snapshot(outside);
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (file: PathOrFileDescriptor, ...args: any[]) => {
    assert.ok(!String(file).startsWith(outside), 'outside data must not be read');
    return read(file, ...args);
  });
  const spawn = cp.spawnSync;
  t.mock.method(cp, 'spawnSync', (command: string, args: string|readonly string[], options: SpawnSyncOptionsWithStringEncoding) => {
    assert.ok(!args.includes('diff'), 'Git must not read work files beneath the junction');
    return spawn(command, args, options);
  });
  const result = run(f, '--path', 'data/blueprints/manifest.json');
  assert.ok(result.unknown.some((r: any) => /junction|symbolic/.test(r)));
  assert.equal(result.incrementalPlan.mode, 'full');
  t.mock.restoreAll();
  assert.deepEqual(snapshot(outside), before);
});

test('clean filters/external diff hooks cannot execute; Git commands have safe environment and argv', (t) => {
  const f = fixture(t);
  f.write('.gitattributes', '*.json filter=fixture');
  git(f.root, 'config', 'filter.fixture.clean', 'node -e "require(\'fs\').writeFileSync(\'FILTER_RAN\',\'bad\')"');
  git(f.root, 'config', 'diff.external', 'definitely-not-an-executable');
  fs.appendFileSync(path.join(f.root, 'data/blueprints/one.json'), '\n');
  const original = cp.spawnSync;
  const commands: any[] = [];
  t.mock.method(cp, 'spawnSync', (command: any, args: readonly string[], options: SpawnSyncOptionsWithStringEncoding) => {
    assert.equal(command, 'git');
    assert.equal(options.shell, false);
    assert.equal(options.env.GIT_NO_LAZY_FETCH, '1');
    assert.equal(options.env.GIT_OPTIONAL_LOCKS, '0');
    assert.equal(options.env.GIT_ALLOW_PROTOCOL, '');
    assert.ok(!args.some((arg: string) => ['fetch', 'pull', 'push', 'checkout', 'update-index'].includes(arg)));
    commands.push(args);
    return original(command, args, options);
  });
  const before = snapshot(f.root);
  const result = run(f);
  assert.equal(result.gitHistory.status, 'compared');
  assert.ok(commands.find((args: any) => args.includes('diff')).includes('filter.fixture.clean='));
  assert.equal(fs.existsSync(path.join(f.root, 'FILTER_RAN')), false);
  assert.deepEqual(snapshot(f.root), before);
});

test('ordering-only and index-only changes identify stable IDs without inventing field edits', (t) => {
  const f = fixture(t);
  const rows = [...f.blueprints].reverse();
  f.write('data/blueprints/one.json', { blueprints: rows });
  f.write('data/scene-blueprints.json', { version: 2, blueprints: rows });
  const result = run(f);
  assert.equal(result.history.entities.length, 0);
  assert.equal(result.history.ordering.length, 2);
  assert.ok(result.affected.some((r: { kind: string; id: string; }) => r.kind === 'blueprint' && r.id === 'bp-a'));
  assert.equal(result.incrementalPlan.mode, 'full');
  const index = f.read('data/scenes-index.json');
  index.orderedIds.reverse();
  f.write('data/scenes-index.json', index);
  const indexResult = run(f);
  assert.ok(indexResult.history.metadata.some((r: { file: string; }) => r.file === 'data/scenes-index.json'));
  assert.ok(indexResult.affected.some((r: { kind: string; id: string; }) => r.kind === 'scene' && r.id === 'sc1000'));
  assert.ok(indexResult.mustChange.some((r: any) => r.object === 'data/scenes-index.json'));
});

test('assume-unchanged cannot be used as evidence that the working tree has no impact', (t) => {
  const f = fixture(t);
  git(f.root, 'update-index', '--assume-unchanged', 'data/blueprints/one.json');
  f.write('data/blueprints/one.json', { blueprints: [] });
  const before = snapshot(f.root);
  const result = run(f);
  assert.ok(result.unknown.some((r: any) => r.includes('Git flag h')));
  assert.equal(result.incrementalPlan.mode, 'full');
  assert.equal(result.incrementalPlan.wholeLibrary, 'not-validated');
  assert.deepEqual(snapshot(f.root), before);
});

test('partial/invalid Git NUL output is discarded and base blobs retain exact byte hashes', (t) => {
  const f = fixture(t);
  const read = collectGitHistory(f.root, f.base).baseReader!.read('data/blueprints/one.json');
  assert.equal(read.sha256, (require('node:crypto') as typeof import('node:crypto')).createHash('sha256').update(fs.readFileSync(path.join(f.root, 'data/blueprints/one.json'))).digest('hex'));
  const spawn = cp.spawnSync;
  for (const stdout of [Buffer.from('M\0data/blueprints/one.json\0D\0missing-terminator'), Buffer.from('R100\0data/blueprints/one.json\0../escape\0'), Buffer.from([255, 0])]) {
    const mock = t.mock.method(cp, 'spawnSync', (command: string, args: string|readonly string[], options: SpawnSyncOptionsWithStringEncoding) => args.includes('diff')
      ? { status: 0, stdout, stderr: Buffer.alloc(0) } : spawn(command, args, options));
    const result = collectGitHistory(f.root, f.base).result;
    assert.equal(result.status, 'error');
    assert.deepEqual(result.paths, []);
    assert.deepEqual(result.changes, []);
    mock.mock.restore();
  }
});

test('pure record comparisons are preview-only and formatter does not mutate results', (t) => {
  const f = fixture(t);
  f.blueprints[0].prompt = 'new text';
  f.write('data/blueprints/one.json', { blueprints: f.blueprints });
  f.write('data/scene-blueprints.json', { version: 2, blueprints: f.blueprints });
  const original = snapshot(f.root);
  const methods = ['writeFileSync', 'appendFileSync', 'renameSync', 'unlinkSync', 'mkdirSync', 'rmSync'];
  const mocks = methods.map((method) => t.mock.method(fs, method, () => { throw new Error(`Unexpected ${method}`); }));
  const result = run(f);
  assert.equal(result.mustChange.length, 0);
  assert.equal(result.incrementalPlan.incrementalChecks[0].status, 'preview');
  const copy = structuredClone(result);
  assert.ok(formatImpactReport(result).includes('预览；未执行'));
  assert.deepEqual(result, copy);
  for (const mock of mocks) mock.mock.restore();
  assert.deepEqual(snapshot(f.root), original);
});
