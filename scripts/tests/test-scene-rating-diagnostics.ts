'use strict';
const { test }: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs: typeof import('node:fs') = require('node:fs');
const os: typeof import('node:os') = require('node:os');
const path: typeof import('node:path') = require('node:path');
const { spawnSync }: typeof import('node:child_process') = require('node:child_process');
const repo = path.resolve(__dirname, '../..');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rating-diagnostic-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (file, value) => { const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value)); };
  const script = fs.readFileSync(path.join(repo, 'scripts/maintenance/classify-scene-ratings.js'), 'utf8');
  put('scripts/maintenance/classify-scene-ratings.js', script);
  put('scripts/lib/scene-store.js', "exports.loadSceneShards = () => ({ scenes: JSON.parse(require('fs').readFileSync(require('path').join(process.env.AICS_DATA_ROOT, 'scenes.json'), 'utf8')) }); exports.writeAggregate = () => { throw Error('unexpected write'); };");
  put('scripts/lib/scene-write.js', "exports.applySceneChanges = () => { throw Error('unexpected write'); };");
  put('scripts/lib/prompt-policy.js', "exports.ratingFor = () => 'All';");
  put('scripts/lib/manual-scene-ratings.js', "module.exports = { sc001: 'R15' };");
  const pinned = Object.fromEntries([...script.matchAll(/id: '(sc\d+)'/g)].map((m) => [m[1], {}]));
  pinned.sc003 = {};
  put('data/prompt-pinned-scenes.json', { scenes: pinned });
  const rows = [1, 2, 3, 4].map((n) => ({ id: 'sc00' + n, rating: 'All', mature: false, category: '日常', usage: [] }));
  rows[3].mature = true;
  put('scenes.json', rows);
  const run = (...args) => spawnSync(process.execPath, [path.join(root, 'scripts/maintenance/classify-scene-ratings.js'), ...args], { encoding: 'utf8', env: { ...process.env, AICS_DATA_ROOT: root } });
  return { root, put, rows, run };
}
function snapshot(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((e) => {
    const target = path.join(root, e.name);
    return e.isDirectory() ? snapshot(target) : [[target, fs.readFileSync(target).toString('base64')]];
  });
}
test('JSON and explain show exact fields and precedence with zero writes', (t) => {
  const { root, run } = fixture(t);
  const before = snapshot(root);
  for (const flag of ['--json', '--explain']) {
    const result = run('--check', flag);
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.changedCount, 2);
    assert.deepEqual(report.changes.map((r) => r.id), ['sc001', 'sc004']);
    assert.deepEqual(report.changes[0].expected, { rating: 'R15', mature: false, category: '日常', usage: ['R15'] });
    assert.equal(report.changes[0].source, 'manual');
    assert.equal(report.changes[1].source, 'existing-mature');
    assert.ok(report.sources.pinned > 0);
    assert.equal(report.sources.policy, 1);
  }
  assert.match(run('--check').stdout, /^ratings: All=\d+ R15=\d+ R18=\d+ changed=2\s*$/);
  assert.deepEqual(snapshot(root), before);
});
test('manual R15 usage repair uses real writers, preserves other fields and is idempotent', (t) => {
  const { root, put, run } = fixture(t);
  for (const name of ['scene-store', 'scene-write']) {
    put('scripts/lib/' + name + '.js', 'module.exports = require(' + JSON.stringify(path.join(repo, 'scripts/lib', name + '.js')) + ');');
  }
  const pinned = JSON.parse(fs.readFileSync(path.join(root, 'data/prompt-pinned-scenes.json'), 'utf8')).scenes;
  const rows = ['sc001', ...Object.keys(pinned)].map((id) => ({
    id, char: 'nene', rating: id === 'sc001' ? 'R15' : 'All', mature: false,
    category: '日常', usage: ['展示图', '头像'], prompt: 'fixture prompt',
    negative: 'fixture negative', animaCaption: 'fixture caption',
    blueprint: { id: 'fixture' }, outfitId: 'fixture', recommendedSize: '832x1216',
  }));
  put('data/scenes/manifest.json', { files: [{ file: 'nene-core.json', character: 'nene' }] });
  put('data/scenes/nene-core.json', rows);
  const before = run('--check', '--json');
  assert.equal(before.status, 1, before.stderr);
  assert.equal(JSON.parse(before.stdout).changedCount, 1);
  const written = run('--write');
  assert.equal(written.status, 0, written.stderr);
  const expected = structuredClone(rows);
  expected[0].usage.push('R15');
  expected.sort((a, b) => a.id.localeCompare(b.id));
  for (const file of ['scenes/nene-core.json', 'scenes.json', 'scenes-nene.json']) {
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'data', file), 'utf8')), expected);
  }
  const repaired = snapshot(root);
  const checked = run('--check', '--json');
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal(JSON.parse(checked.stdout).changedCount, 0);
  assert.equal(JSON.parse(checked.stdout).visualReview, 'unverified');
  assert.deepEqual(snapshot(root), repaired);
  assert.equal(run('--write').status, 0);
  assert.deepEqual(snapshot(root), repaired);
});

test('unknown/duplicate flags and write combinations fail closed', (t) => {
  const { root, run } = fixture(t);
  const before = snapshot(root);
  for (const args of [['--json', '--wat'], ['--json', '--json'], ['--json', '--write'], ['--explain', '--write']]) assert.equal(run(...args).status, 2);
  assert.deepEqual(snapshot(root), before);
});
test('unknown ratings, duplicate ids and missing fields fail closed', (t) => {
  const { root, put, rows, run } = fixture(t);
  for (const bad of [[...rows, rows[0]], rows.map((r, i) => i ? r : { ...r, rating: 'Unknown' }), rows.map((r, i) => i ? r : { id: r.id })]) {
    put('scenes.json', bad);
    const before = snapshot(root);
    const result = run('--json');
    assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stdout).status, 'invalid');
    assert.deepEqual(snapshot(root), before);
  }
});
test('manual table unknown, duplicate and missing values fail closed without executing code', (t) => {
  const { root, put, run } = fixture(t);
  for (const raw of ["module.exports = { sc001: 'Unknown' };", "module.exports = { sc001: 'All', sc001: 'R15' };", 'module.exports = { sc001: };', "require('fs').writeFileSync('unexpected', 'x'); module.exports = {};"]) {
    put('scripts/lib/manual-scene-ratings.js', raw);
    const before = snapshot(root);
    assert.equal(run('--explain').status, 2);
    assert.deepEqual(snapshot(root), before);
  }
});
