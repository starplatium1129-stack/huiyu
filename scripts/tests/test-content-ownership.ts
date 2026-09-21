'use strict';
const { test }: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs: typeof import('node:fs') = require('node:fs');
const os: typeof import('node:os') = require('node:os');
const path: typeof import('node:path') = require('node:path');
const { spawnSync }: typeof import('node:child_process') = require('node:child_process');
const { reportOwnership }: typeof import('../maintenance/report-content-ownership') = require('../maintenance/report-content-ownership');
const repo = path.resolve(__dirname, '../..');
function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ownership-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (file: any, value: any) => { const p = path.join(root, file); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value)); };
  put('data/characters.json', [{ id: 'a', name: 'A' }]);
  put('scripts/lib/manual-scene-ratings.js', "module.exports = { sc001: 'All' };");
  put('scripts/maintenance/classify-scene-ratings.js', '// fixture entry');
  for (const domain of ['popular', 'scenes', 'blueprints']) {
    put(`data/${domain}/manifest.json`, { files: [{ file: 'a.json' }] });
    const value = domain === 'scenes' ? [{ id: 'sc001' }] : { [domain === 'popular' ? 'characters' : 'blueprints']: [{ id: 'a' }] };
    put(`data/${domain}/${domain === 'scenes' ? 'a.1.json' : 'a.json'}`, value);
    put('data/' + { popular: 'popular-characters.json', scenes: 'scenes.json', blueprints: 'scene-blueprints.json' }[domain], value);
  }
  for (const name of ['nene', 'natsume', 'shared', 'core']) put(`data/scenes-${name}.json`, []);
  put('data/scenes-index.json', { total: 1, shards: {} });
  put('data/curation.json', { curatedSceneIds: [], signatureSceneIds: [], personaCoreSceneIds: [] });
  put('data/retired-scenes.json', { records: [] });
  put('data/character-reference-standards.json', { perspectives: [], characters: [] });
  put('data/character-reference-view.json', { a: { outfits: [] } });
  put('src/assets/css/director/tokens.css', '.pb { --character-accent: red; }');
  return { root, put };
}
function snapshot(root: any): any {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(root, e.name);
    return e.isDirectory() ? snapshot(p) : [[p, fs.readFileSync(p).toString('base64')]];
  });
}
function cli(root: any, args: any = [], workflow: any = false) {
  return spawnSync(process.execPath, [path.join(repo, workflow ? 'scripts/workflow.js' : 'scripts/maintenance/report-content-ownership.js'), ...(workflow ? ['audit:ownership'] : []), '--root', root, ...args], { encoding: 'utf8' });
}
test('all domains report real sources/products and batch ownership without accepting quality', (t) => {
  const { root } = fixture(t);
  const report = reportOwnership({ root });
  assert.equal(report.domains.length, 10);
  const entries = report.domains.flatMap((d) => d.entries);
  assert.ok(entries.every((e) => ['source', 'product', 'external-unknown'].includes(e.status)));
  assert.ok(entries.every((e) => e.quality === 'unverified'));
  assert.ok(entries.some((e) => e.path === 'data/scenes/a.1.json' && e.logicalGroup === 'a.json'));
  assert.ok(entries.find((e) => e.path === 'data/characters.json').entityFields.includes('name'));
});
test('scene-ratings records manual ownership without accepting review and rejects malformed tables', (t) => {
  const { root, put } = fixture(t);
  const before = snapshot(root);
  const direct = cli(root, ['--domain', 'scene-ratings', '--json']);
  assert.equal(direct.status, 0);
  assert.deepEqual(JSON.parse(direct.stdout), JSON.parse(cli(root, ['--domain', 'scene-ratings', '--json'], true).stdout));
  assert.ok(JSON.parse(direct.stdout).domains[0].entries.every((e: any) => e.quality === 'unverified'));
  assert.deepEqual(snapshot(root), before);
  for (const raw of ["module.exports = { sc001: 'Unknown' };", "module.exports = { sc001: 'All', sc001: 'R15' };", 'module.exports = { sc001: };']) {
    put('scripts/lib/manual-scene-ratings.js', raw);
    assert.equal(cli(root, ['--domain', 'scene-ratings', '--json']).status, 1);
  }
  fs.unlinkSync(path.join(root, 'scripts/lib/manual-scene-ratings.js'));
  assert.equal(cli(root, ['--domain', 'scene-ratings', '--json']).status, 1);
});
test('updated ownership notes surface key responsibilities in JSON and text output', (t) => {
  const { root } = fixture(t);
  const report = reportOwnership({ root });
  const byDomain = Object.fromEntries(report.domains.map((d) => [d.domain, d]));
  assert.ok(byDomain.characters.readers.some((r: any) => r.includes('characterProfiles.ts')));
  assert.ok(byDomain.characters.readers.some((r: any) => r.includes('usePromptAssembly.ts') && r.includes('traits')));
  assert.ok(byDomain.characters.fields.includes('traits 另由提示词组装消费'));
  assert.ok(byDomain.characters.readers.some((r: any) => r.includes('report-content-coverage.js') && r.includes('accent_color')));
  assert.ok(byDomain.characters.writers.some((w: any) => w.includes('cleanOrphanedSceneRefs')));
  assert.ok(byDomain.characters.boundary.includes('不代表详情页展示'));
  assert.ok(byDomain.popular.readers.some((r: any) => r.includes('parseOutfit')));
  assert.ok(byDomain.popular.readers.some((r: any) => r.includes('loadPopularShards') && r.includes('build 与启动自愈')));
  assert.ok(byDomain.popular.boundary.includes('isDefault'));
  for (const key of ['blueprints:build', 'blueprints:import', 'apply-scene-patch.js']) assert.ok(byDomain.blueprints.writers.some((w: any) => w.includes(key)));
  assert.ok(byDomain.blueprints.writers.some((w: any) => w.includes('blueprint-write.js') && w.includes('分片/manifest/聚合')));
  assert.ok(byDomain.blueprints.boundary.includes('重启自愈'));
  assert.ok(byDomain.references.writers.some((w: any) => w.includes('合并写入')));
  assert.ok(byDomain.references.writers.some((w: any) => w.includes('writeReferenceLibrary')));
  assert.ok(byDomain.references.boundary.includes('不入 Git') && byDomain.references.boundary.includes('不手工编辑'));
  assert.ok(byDomain.references.fields.includes('机位'));
  assert.ok(byDomain.themes.readers.some((r: any) => r.includes('--character-')));
  assert.ok(byDomain.themes.readers.some((r: any) => r.includes('accent_color')));
  assert.ok(report.scope.includes('不声称穷尽'));
  const text = cli(root, ['--domain', 'characters']).stdout;
  assert.ok(text.includes('characterProfiles.ts'));
  assert.ok(text.includes('cleanOrphanedSceneRefs'));
});
test('missing shard and malformed manifest remain errors, never rebuild products', (t) => {
  const { root, put } = fixture(t);
  fs.unlinkSync(path.join(root, 'data/popular/a.json'));
  put('data/blueprints/manifest.json', { files: [{ file: '../characters.json' }] });
  const entries = reportOwnership({ root }).domains.flatMap((d) => d.entries);
  assert.equal(entries.find((e) => e.path === 'data/popular/a.json').status, 'missing');
  assert.equal(entries.find((e) => e.path === 'data/blueprints/manifest.json').status, 'invalid');
  assert.equal(cli(root, ['--json']).status, 1);
});
test('bad JSON and duplicate manifest entries fail closed', (t) => {
  const { root, put } = fixture(t);
  put('data/popular/manifest.json', '{');
  assert.equal(reportOwnership({ root, domain: 'popular' }).domains[0].entries[0].status, 'invalid');
  put('data/popular/manifest.json', { files: [{ file: 'a.json' }, { file: 'a.json' }] });
  assert.equal(reportOwnership({ root, domain: 'popular' }).domains[0].entries[0].status, 'invalid');
});
test('domain isolates reads and showcase stays external unknown', (t) => {
  const { root, put } = fixture(t);
  put('data/characters.json', '{');
  const result = cli(root, ['--domain', 'showcase', '--json']);
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).domains[0].entries[0].status, 'external-unknown');
  assert.equal(cli(root, ['--domain', 'unknown']).status, 2);
  assert.equal(cli(root, ['--domain']).status, 2);
});
test('help and plan work with nonexistent root through direct CLI and workflow', () => {
  for (const workflow of [false, true]) for (const flag of ['--help', '--plan']) assert.equal(cli(path.join(os.tmpdir(), 'ownership-nonexistent-root'), [flag], workflow).status, 0);
});
test('CLI and workflow agree and leave fixture bytes and file set unchanged', (t) => {
  const { root } = fixture(t);
  const before = snapshot(root);
  const direct = cli(root, ['--json']);
  const workflow = cli(root, ['--json'], true);
  assert.equal(direct.status, 0);
  assert.equal(workflow.status, 0);
  assert.deepEqual(JSON.parse(direct.stdout), JSON.parse(workflow.stdout));
  assert.deepEqual(snapshot(root), before);
});
test('junction outside isolated root is rejected before reading its JSON', (t) => {
  const { root } = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ownership-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.renameSync(path.join(root, 'data/popular'), path.join(outside, 'popular'));
  fs.symlinkSync(path.join(outside, 'popular'), path.join(root, 'data/popular'), process.platform === 'win32' ? 'junction' : 'dir');
  const before = snapshot(outside);
  assert.equal(reportOwnership({ root, domain: 'popular' }).domains[0].entries[0].status, 'invalid');
  assert.deepEqual(snapshot(outside), before);
});
