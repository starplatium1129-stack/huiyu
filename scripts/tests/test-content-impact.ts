'use strict';
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs: typeof import('node:fs') = require('node:fs');
const os: typeof import('node:os') = require('node:os');
const path: typeof import('node:path') = require('node:path');
const { test }: typeof import('node:test') = require('node:test');
const { spawnSync }: typeof import('node:child_process') = require('node:child_process');
const { parse, report }: typeof import('../maintenance/report-content-impact') = require('../maintenance/report-content-impact');
const { formatImpactReport }: typeof import('../lib/content-impact-format') = require('../lib/content-impact-format');

function git(root: any, ...args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}
function gitFixture(t: any) {
  const f = sceneFixture(t);
  git(f.root, 'init');
  git(f.root, 'add', '.');
  git(f.root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture');
  return f;
}

test('Git staged/unstaged/untracked 与角色场景路径样张组合，索引及文件零写入', (t) => {
  const f = gitFixture(t);
  fs.appendFileSync(path.join(f.root, 'data/popular/one.json'), ' ');
  git(f.root, 'add', 'data/popular/one.json');
  fs.appendFileSync(path.join(f.root, 'data/blueprints/one.json'), ' ');
  fs.appendFileSync(path.join(f.root, 'data/scenes/base.2.json'), ' ');
  f.write('未知 file.json', {});
  f.write('showcase.json', { entries: [{ id: 'sc001', char: 'a' }] });
  f.write('src/assets/css/director/tokens.css', null);
  f.write('docs/workflow.md', null);
  const before = snapshot(f.root);
  const args = ['--root', f.root, '--git-diff', '--character', 'a', '--scene', 'sc001', '--path', 'manual.txt', '--showcase-manifest', 'showcase.json'];
  const r = report(parse(args));
  assert.equal(r.gitChanges.status, 'collected');
  for (const file of ['data/popular/one.json', 'data/blueprints/one.json', 'data/scenes/base.2.json', '未知 file.json']) assert.ok(r.gitChanges.paths.includes(file));
  assert.deepEqual(r.scenes.map((x: any) => x.id), ['sc001', 'sc002']);
  assert.ok(r.revalidate.some((x: any) => x.domain === 'blueprint'));
  for (const domain of ['theme', 'workflow']) assert.ok(r.revalidate.some((x: any) => x.domain === domain));
  assert.ok(r.unknown.some((x: any) => x.includes('manual.txt')));
  assert.ok(r.unknown.some((x: any) => x.includes('未知 file.json')));
  assert.equal(r.showcase.manifests[0].entries.length, 1);
  for (const prefix of [[path.resolve(__dirname, '../maintenance/report-content-impact.js')], [path.resolve(__dirname, '../workflow.js'), 'audit:impact']]) {
    const cli = spawnSync(process.execPath, [...prefix, ...args, '--json'], { encoding: 'utf8' });
    assert.equal(JSON.parse(cli.stdout).gitChanges.status, 'collected');
  }
  assert.deepEqual(snapshot(f.root), before);
});

test('Git rename 两端和 quoted 名称完整保留，干净仓库可单独执行', (t) => {
  const f = gitFixture(t);
  assert.deepEqual(report(parse(['--root', f.root, '--git-diff'])).gitChanges.paths, []);
  git(f.root, 'mv', 'data/popular/one.json', 'data/popular/renamed file.json');
  const name = process.platform === 'win32' ? '中文 file.txt' : 'quote"line\n.txt';
  f.write(name, {});
  const r = report(parse(['--root', f.root, '--git-diff']));
  for (const file of ['data/popular/one.json', 'data/popular/renamed file.json', name]) assert.ok(r.gitChanges.paths.includes(file));
  assert.ok(r.gitChanges.raw[1].stdout.includes('\0'));
});

test('Git 非仓库、无 HEAD 和子目录 fail-closed，错误 CLI 退出 1', (t) => {
  const f = fixture(t);
  const script = path.resolve(__dirname, '../maintenance/report-content-impact.js');
  const run = () => report(parse(['--root', f.root, '--git-diff']));
  assert.equal(run().gitChanges.status, 'error');
  assert.equal(spawnSync(process.execPath, [script, '--root', f.root, '--git-diff', '--json']).status, 1);
  git(f.root, 'init');
  assert.deepEqual(run().gitChanges.paths, []);
  assert.equal(run().gitChanges.status, 'error');
  const g = gitFixture(t);
  assert.equal(report(parse(['--root', path.join(g.root, 'data'), '--git-diff'])).gitChanges.status, 'error');
});

test('未启用、帮助及预览不启动 Git；命令失败及不可解析输出拒绝部分结果', (t) => {
  const cp: typeof import('node:child_process') = require('node:child_process');
  const f = fixture(t);
  let calls = 0;
  t.mock.method(cp, 'spawnSync', () => { calls++; throw new Error('unexpected Git'); });
  report(options(f.root));
  const { main }: typeof import('../maintenance/report-content-impact') = require('../maintenance/report-content-impact');
  t.mock.method(console, 'log', () => {});
  for (const flag of ['--help', '--plan']) assert.equal(main(['--git-diff', flag]), 0);
  assert.equal(calls, 0);
  assert.equal(report(parse(['--root', f.root, '--git-diff'])).gitChanges.status, 'error');
  for (const bad of [Buffer.from('unterminated'), Buffer.from('../outside\0'), Buffer.from([255, 0])]) {
    let n = 0;
    t.mock.method(cp, 'spawnSync', () => ({ status: 0, stdout: n++ === 0 ? Buffer.from(f.root + '\n') : bad, stderr: Buffer.alloc(0) }));
    const r = report(parse(['--root', f.root, '--git-diff']));
    assert.equal(r.gitChanges.status, 'error');
    assert.deepEqual(r.gitChanges.paths, []);
  }
});

function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-impact-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file: any, value: any) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), JSON.stringify(value));
  };
  const characters = [{ id: 'a', outfits: [{ id: 'dress' }, { id: 'coat' }] }, { id: 'b', outfits: [{ id: 'dress' }] }];
  const blueprints = [{ id: 'a1', characterId: 'a', outfitId: 'dress' }, { id: 'a2', characterId: 'a', outfitId: 'coat' }, { id: 'b1', characterId: 'b', outfitId: 'dress' }];
  for (const [domain, key, rows, aggregate, version] of [['popular', 'characters', characters, 'popular-characters', 1], ['blueprints', 'blueprints', blueprints, 'scene-blueprints', 2]]) {
    write(`data/${domain}/manifest.json`, { files: [{ file: 'one.json', count: rows.length }] });
    write(`data/${domain}/one.json`, { [key]: rows });
    write(`data/${aggregate}.json`, { version, [key]: rows });
  }
  write('data/character-reference-view.json', { a: { outfits: [{ outfitId: 'dress' }] } });
  return { root, write, characters, blueprints };
}
const options = (root: any, extra = {}) => ({ root, paths: [], character: 'a', ...extra });
test('reference 声明统计、显式服装及路径多角色过滤，CLI/工作流零写入', (t) => {
  const f = fixture(t);
  f.write('data/character-reference-view.json', {
    a: { outfits: [{ outfitId: 'dress', references: [{ pending: true, url: 'https://invalid.test/x', review: 'pass' }, { url: ' ' }, { url: '/outside/image.png' }] },
      { outfitId: 'coat', references: [{ url: 'file:///outside/image.png' }] }] },
    b: { outfits: [{ outfitId: 'other', references: [] }] },
  });
  const before = snapshot(f.root);
  const args = ['--root', f.root, '--character', 'a', '--outfit', 'dress', '--path', 'data/popular/one.json', '--json'];
  const expected = report(parse(args)).referenceEvidence;
  assert.deepEqual(expected.map((r: any) => [r.characterId, r.outfitId, r.status]), [['a', 'dress', 'pending'], ['b', 'other', 'empty']]);
  assert.deepEqual([expected[0].total, expected[0].pendingCount, expected[0].urlDeclaredCount, expected[0].reviewDeclaredCount], [3, 2, 2, 1]);
  assert.equal(expected[0].reviewStatus, 'declared-unverified');
  assert.ok(expected.every((r: any) => r.assetStatus === 'unverified'));
  const coat = report(options(f.root, { outfit: 'coat' })).referenceEvidence[0];
  assert.equal(coat.status, 'declared-unverified');
  assert.equal(coat.reviewStatus, 'unknown');
  for (const prefix of [[path.resolve(__dirname, '../maintenance/report-content-impact.js')], [path.resolve(__dirname, '../workflow.js'), 'audit:impact']]) {
    const cli = spawnSync(process.execPath, [...prefix, ...args], { encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr);
    assert.deepEqual(JSON.parse(cli.stdout).referenceEvidence, expected);
  }
  assert.deepEqual(snapshot(f.root), before);
});

test('reference 缺角色/服装/references 登记与坏 view 保持未知边界', (t) => {
  const f = fixture(t);
  const run = (extra?: any) => report(options(f.root, extra)).referenceEvidence[0];
  assert.equal(run().status, 'missing');
  assert.equal(run({ character: 'b' }).status, 'missing');
  assert.equal(run({ outfit: 'absent' }).status, 'missing');
  for (const value of [null, [], { a: { outfits: [null] } }, { a: { outfits: [{ outfitId: 'dress', references: [null] }] } }]) {
    f.write('data/character-reference-view.json', value);
    assert.equal(run().status, 'unknown');
    assert.equal(run().total, null);
  }
  fs.writeFileSync(path.join(f.root, 'data/character-reference-view.json'), '{bad');
  assert.equal(run().status, 'unknown');
  fs.unlinkSync(path.join(f.root, 'data/character-reference-view.json'));
  assert.equal(run().status, 'unknown');
});

test('reference 仅读取索引，URL 和配置的素材根不访问', (t) => {
  const f = fixture(t);
  f.write('data/character-reference-view.json', { a: { outfits: [{ outfitId: 'dress', references: [{ url: 'https://invalid.test/image' }] }] } });
  const original = fs.readFileSync;
  const reads: any = [];
  t.mock.method(fs, 'readFileSync', (file: any, ...args) => { reads.push(String(file)); return original(file, ...args); });
  t.mock.method(globalThis, 'fetch', () => { throw new Error('network forbidden'); });
  const r = report(options(f.root));
  assert.equal(r.referenceEvidence[0].status, 'declared-unverified');
  assert.ok(reads.every((file: any) => file.startsWith(f.root)));
  assert.ok(r.related.some((x: any) => x.domain === 'reference'));
  assert.ok(r.revalidate.some((x: any) => x.domain === 'reference'));
});
function defaultsFixture(t: any, outfits: any) {
  const f = fixture(t);
  f.characters[0].outfits = outfits;
  f.blueprints.push({ id: 'implicit', characterId: 'a' });
  f.write('data/blueprints/manifest.json', { files: [{ file: 'one.json', count: f.blueprints.length }] });
  f.write('data/popular/one.json', { characters: f.characters });
  f.write('data/popular-characters.json', { version: 1, characters: f.characters });
  f.write('data/blueprints/one.json', { blueprints: f.blueprints });
  f.write('data/scene-blueprints.json', { version: 2, blueprints: f.blueprints });
  return f;
}
test('唯一一致默认解析到非首项，路径覆盖每个所选角色，显式服装行为保留', (t) => {
  const { root } = defaultsFixture(t, [{ id: 'dress', default: false, isDefault: false }, { id: 'coat', default: true, isDefault: true }]);
  const r = report(options(root, { outfit: 'dress' }));
  assert.equal(r.outfitDefaults[0].status, 'explicit');
  assert.equal(r.outfitDefaults[0].defaultOutfit, 'coat');
  assert.deepEqual(r.mustChange, []);
  const bps = r.revalidate.filter((x: any) => x.domain === 'blueprint');
  assert.deepEqual(bps.map((x: any) => x.object), ['data/blueprints/one.json#a1', 'data/blueprints/one.json#implicit']);
  assert.match(bps[1].reason, /a\/coat/);
  const all = report(options(root, { character: null, paths: ['data/popular/one.json'] }));
  assert.deepEqual(all.outfitDefaults.map((x: any) => [x.id, x.status]), [['a', 'explicit'], ['b', 'unknown']]);
});
test('双字段冲突、多默认、无默认及默认 ID 缺失或重复均报告必改', (t) => {
  const cases = [
    [[{ id: 'dress', default: true, isDefault: false }, { id: 'coat', default: false, isDefault: true }], 'mismatch'],
    [[{ id: 'dress', default: true, isDefault: true }, { id: 'coat', default: true, isDefault: true }], 'ambiguous'],
    [[{ id: 'dress', default: false, isDefault: false }, { id: 'coat', default: false, isDefault: false }], 'missing'],
    [[{ default: true, isDefault: true }], 'missing'],
    [[{ id: ' ', default: true, isDefault: true }], 'missing'],
    [[{ id: 'dress', default: true, isDefault: true }, { id: 'dress', default: false, isDefault: false }], 'ambiguous'],
    [[{ id: 'dress', default: true }, { id: 'coat', default: true }], 'ambiguous'],
  ];
  for (const [outfits, status] of cases) {
    const { root } = defaultsFixture(t, outfits);
    const r = report(options(root));
    assert.equal(r.outfitDefaults[0].status, status);
    assert.equal(r.outfitDefaults[0].defaultOutfit, null);
    assert.ok(r.mustChange.some((x: any) => x.domain === 'outfit-default'));
    assert.ok(r.unknown.some((x: any) => x.includes('#implicit')));
  }
});
test('旧格式、非布尔或部分字段与未知身份不猜默认第一项', (t) => {
  for (const outfits of [[], [{ id: 'dress' }], [{ id: 'dress', default: true }], [{ id: 'dress', default: 'true', isDefault: 'true' }], [{ id: 'dress', default: true, isDefault: true }, { id: 'coat' }]]) {
    const { root } = defaultsFixture(t, outfits);
    const r = report(options(root));
    assert.equal(r.outfitDefaults[0].status, 'unknown');
    assert.equal(r.outfitDefaults[0].defaultOutfit, null);
    assert.ok(!r.mustChange.some((x: any) => x.domain === 'outfit-default'));
    assert.ok(r.unknown.some((x: any) => x.includes('#implicit') && x.includes('unknown')));
    assert.equal(report(options(root, { character: 'absent' })).outfitDefaults[0].status, 'unknown');
  }
});
test('重复角色身份不能解析默认，缺失 outfits 保留未知结果', (t) => {
  const f = defaultsFixture(t, [{ id: 'dress', default: true, isDefault: true }]);
  f.characters[1].id = 'a';
  f.write('data/popular/one.json', { characters: f.characters });
  assert.equal(report(options(f.root)).outfitDefaults[0].status, 'unknown');
  delete f.characters[0].outfits;
  f.characters.pop();
  f.write('data/popular/manifest.json', { files: [{ file: 'one.json', count: 1 }] });
  f.write('data/popular/one.json', { characters: f.characters });
  assert.equal(report(options(f.root)).outfitDefaults[0].status, 'unknown');
});
test('默认服装 CLI 与工作流成功/错误均零写入，文本含独立结果', (t) => {
  for (const flag of [true, false]) {
    const { root } = defaultsFixture(t, [{ id: 'dress', default: flag, isDefault: flag }, { id: 'coat', default: false, isDefault: false }]);
    const before = snapshot(root);
    for (const prefix of [[path.resolve(__dirname, '../maintenance/report-content-impact.js')], [path.resolve(__dirname, '../workflow.js'), 'audit:impact']]) {
      const args = [...prefix, '--root', root, '--character', 'a'];
      const r = spawnSync(process.execPath, [...args, '--json'], { encoding: 'utf8' });
      assert.equal(r.status, flag ? 0 : 1, r.stderr);
      assert.equal(JSON.parse(r.stdout).outfitDefaults[0].status, flag ? 'explicit' : 'missing');
      assert.match(spawnSync(process.execPath, args, { encoding: 'utf8' }).stdout, /outfitDefaults:/);
    }
    assert.deepEqual(snapshot(root), before);
  }
});
const themeFile = 'src/assets/css/director/tokens.css';
function themeFixture(t: any, css = '.pb { --accent: pink; }') {
  const f = fixture(t);
  f.write('data/characters.json', [{ id: 'a' }, { id: 'nene' }]);
  f.write(themeFile, null);
  fs.writeFileSync(path.join(f.root, themeFile), css);
  return f;
}

test('主题选择器按所选角色/服装关联，忽略注释和声明字符串', (t) => {
  const { root } = themeFixture(t, `/* [data-character="nene"] {} */
    body:has(.pb[data-character])::before { color: red; }
    .pb[data-character="a"], .pb[data-character = 'b'] { --accent: red; content: 'data-character="nene"'; }`);
  const r = report(options(root, { outfit: 'dress' }));
  assert.deepEqual(r.themes.map((x: any) => [x.id, x.themeStatus]), [['a', 'explicit']]);
  for (const level of ['related', 'revalidate']) assert.deepEqual(r[level].filter((x: any) => x.domain === 'theme').map((x: any) => x.object), [`${themeFile}#a`]);
  assert.deepEqual(r.mustChange, []);
  assert.equal(report(options(root, { character: 'nene' })).themes[0].themeStatus, 'default');
  const all = report(options(root, { character: null, paths: ['data/popular/one.json'] }));
  assert.deepEqual(all.themes.map((x: any) => [x.id, x.themeStatus]), [['a', 'explicit'], ['b', 'explicit']]);
});

test('canonical 缺主题为 missing，外部热门角色保持 unknown', (t) => {
  const { root } = themeFixture(t);
  const r = report(options(root, { character: null, paths: ['data/popular/one.json'] }));
  assert.deepEqual(r.themes.map((x: any) => [x.id, x.themeStatus]), [['a', 'missing'], ['b', 'unknown']]);
  assert.deepEqual(r.mustChange.filter((x: any) => x.domain === 'theme').map((x: any) => x.object), [`${themeFile}#a`]);
  assert.match(r.themes[1].reason, /外部热门角色/);
});

test('缺失 CSS 包括默认角色均未知，缺失 canonical 数据不猜缺主题', (t) => {
  const { root } = fixture(t);
  for (const character of ['a', 'nene', 'b']) {
    const r = report(options(root, { character }));
    assert.equal(r.themes[0].themeStatus, 'unknown');
    assert.match(r.themes[0].reason, /tokens.css/);
    assert.deepEqual(r.mustChange, []);
  }
  const f = themeFixture(t);
  fs.unlinkSync(path.join(f.root, 'data/characters.json'));
  const r = report(options(f.root));
  assert.equal(r.themes[0].themeStatus, 'unknown');
  assert.match(r.themes[0].reason, /characters.json/);
  assert.deepEqual(r.mustChange, []);
});

test('CSS 损坏/不支持语法和 canonical 无效不能证明缺主题', (t) => {
  const { root, write } = themeFixture(t);
  for (const css of ['.pb {', '/* only a comment */', '[data-character="a" i] { color: red; }']) {
    fs.writeFileSync(path.join(root, themeFile), css);
    const r = report(options(root));
    assert.equal(r.themes[0].themeStatus, 'unknown');
    assert.deepEqual(r.mustChange, []);
  }
  fs.writeFileSync(path.join(root, themeFile), '.pb { color: red; }');
  for (const records of [{}, [{ id: 'a' }, { id: 'a' }], [null]]) {
    write('data/characters.json', records);
    assert.equal(report(options(root)).themes[0].themeStatus, 'unknown');
    assert.deepEqual(report(options(root)).mustChange, []);
  }
});

test('档案角色不依赖热门登记；显式主题不依赖 canonical 数据', (t) => {
  const { root, write } = themeFixture(t, '[data-character=a] { color: red; }');
  write('data/characters.json', [{ id: 'archive_only' }]);
  const r = report(options(root, { character: 'archive_only' }));
  assert.equal(r.themes[0].themeStatus, 'missing');
  assert.ok(r.unknown.some((x: any) => x.includes('当前热门源中不存在')));
  fs.writeFileSync(path.join(root, 'data/characters.json'), '{');
  assert.equal(report(options(root)).themes[0].themeStatus, 'explicit');
});

test('主题 CLI/工作流成功与缺主题退出码、帮助预览均零写入', (t) => {
  const { root } = themeFixture(t, '[data-character="a"] { color: red; }');
  const before = snapshot(root);
  for (const prefix of [[path.resolve(__dirname, '../maintenance/report-content-impact.js')], [path.resolve(__dirname, '../workflow.js'), 'audit:impact']]) {
    const args = [...prefix, '--root', root, '--character', 'a'];
    const json = spawnSync(process.execPath, [...args, '--json'], { encoding: 'utf8' });
    assert.equal(json.status, 0, json.stderr);
    assert.equal(JSON.parse(json.stdout).themes[0].themeStatus, 'explicit');
    assert.match(spawnSync(process.execPath, args, { encoding: 'utf8' }).stdout, /themes:/);
    for (const flag of ['--help', '--plan']) assert.equal(spawnSync(process.execPath, [...prefix, '--root', path.join(root, 'absent'), flag]).status, 0);
  }
  assert.deepEqual(snapshot(root), before);
  fs.writeFileSync(path.join(root, themeFile), '.pb { color: red; }');
  const missingBefore = snapshot(root);
  assert.equal(spawnSync(process.execPath, [path.resolve(__dirname, '../maintenance/report-content-impact.js'), '--root', root, '--character', 'a', '--json']).status, 1);
  assert.deepEqual(snapshot(root), missingBefore);
});
function sceneFixture(t: any) {
  const f = fixture(t);
  const scenes = [{ id: 'sc001', char: 'a' }, { id: 'sc002', char: 'a' }, { id: 'sc003', char: 'b' }];
  f.write('data/scenes/manifest.json', { files: [{ file: 'base.json', character: 'a' }, { file: 'base-extra.json', character: 'b' }] });
  f.write('data/scenes/base.1.json', [scenes[0]]);
  f.write('data/scenes/base.2.json', [scenes[1]]);
  f.write('data/scenes/base-extra.json', [scenes[2]]);
  f.write('data/scenes.json', scenes);
  f.write('data/curation.json', { curatedSceneIds: ['sc001'], signatureSceneIds: ['sc002'], personaCoreSceneIds: ['sc001', 'sc003'] });
  f.write('data/retired-scenes.json', { records: [{ id: 'sc099', reason: 'retired fixture' }] });
  return { ...f, scenes, run: (args: any) => report(parse(['--root', f.root, ...args])) };
}

test('精选路径选择三层当前 ID 并独立报告源与场景状态', (t) => {
  const { run } = sceneFixture(t);
  const r = run(['--path', 'data/curation.json']);
  assert.deepEqual(r.scenes.map((s: any) => s.id), ['sc001', 'sc002', 'sc003']);
  assert.deepEqual(r.mustChange, []);
  for (const level of ['related', 'revalidate']) assert.ok(r[level].some((x: any) => x.domain === 'curation-source'));
  for (const s of r.scenes) {
    assert.equal(s.aggregate.status, 'current');
    assert.equal(s.retirement.status, 'not-listed');
    assert.equal(Object.keys(s.curation).length, 3);
  }
  assert.ok(r.unknown.some((x: any) => x.includes('历史删除记录')));
});

test('退役路径选当前 ID，未知历史不列必改，当前冲突仍报告', (t) => {
  const { run, write } = sceneFixture(t);
  const r = run(['--path', 'data/retired-scenes.json']);
  assert.deepEqual(r.scenes.map((s: any) => s.id), ['sc099']);
  assert.equal(r.scenes[0].aggregate.status, 'absent');
  assert.equal(r.scenes[0].retirement.status, 'retired');
  assert.deepEqual(r.mustChange, []);
  for (const level of ['related', 'revalidate']) for (const domain of ['retired-source', 'retired-scene']) assert.ok(r[level].some((x: any) => x.domain === domain));
  write('data/retired-scenes.json', { records: [{ id: 'sc001' }] });
  assert.ok(run(['--path', 'data/retired-scenes.json']).mustChange.some((x: any) => x.domain === 'retired-scene'));
});

test('显式坏/缺失元数据拒绝部分 ID，CLI/工作流失败且零写入', (t) => {
  const { root, write, run } = sceneFixture(t);
  for (const [file, bad] of [
    ['data/curation.json', { curatedSceneIds: ['sc001'], signatureSceneIds: [null], personaCoreSceneIds: [] }],
    ['data/retired-scenes.json', { records: [{ id: 'sc099' }, {}] }],
  ]) for (const value of [bad, {}, null, 'broken', undefined]) {
    if (value === undefined) fs.unlinkSync(path.join(root, file));
    else if (value === 'broken') fs.writeFileSync(path.join(root, file), '{');
    else write(file, value);
    const before = snapshot(root);
    const r = run(['--path', file]);
    assert.deepEqual(r.scenes, []);
    assert.ok(r.mustChange.some((x: any) => x.object === file));
    assert.ok(r.unknown.some((x: any) => x.includes(file)));
    for (const prefix of [[path.resolve(__dirname, '../maintenance/report-content-impact.js')], [path.resolve(__dirname, '../workflow.js'), 'audit:impact']]) {
      const cli = spawnSync(process.execPath, [...prefix, '--root', root, '--path', file, '--json'], { encoding: 'utf8' });
      assert.equal(cli.status, 1, cli.stderr);
      assert.deepEqual(JSON.parse(cli.stdout).scenes, []);
    }
    assert.deepEqual(snapshot(root), before);
  }
});

test('空登记和聚合/manifest/历史路径不猜 ID', (t) => {
  const { run, write } = sceneFixture(t);
  write('data/curation.json', { curatedSceneIds: [], signatureSceneIds: [], personaCoreSceneIds: [] });
  write('data/retired-scenes.json', { records: [] });
  for (const file of ['data/curation.json', 'data/retired-scenes.json', 'data/scenes.json', 'data/scenes/manifest.json', 'data/scenes/deleted.json']) {
    const r = run(['--path', file]);
    assert.deepEqual(r.scenes, []);
    assert.deepEqual(r.mustChange, []);
    assert.ok(r.unknown.some((x: any) => x.includes(file)));
  }
});

test('Git 元数据路径复用显式分析，CLI/工作流与索引零写入', (t) => {
  const { root } = gitFixture(t);
  for (const file of ['data/curation.json', 'data/retired-scenes.json']) fs.appendFileSync(path.join(root, file), ' ');
  git(root, 'add', 'data/curation.json');
  const before = snapshot(root);
  const explicit = report(parse(['--root', root, '--path', 'data/curation.json', '--path', 'data/retired-scenes.json']));
  for (const prefix of [[path.resolve(__dirname, '../maintenance/report-content-impact.js')], [path.resolve(__dirname, '../workflow.js'), 'audit:impact']]) {
    const cli = spawnSync(process.execPath, [...prefix, '--root', root, '--git-diff', '--json'], { encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr);
    const r = JSON.parse(cli.stdout);
    for (const key of ['scenes', 'related', 'revalidate', 'mustChange']) assert.deepEqual(r[key], explicit[key]);
  }
  assert.deepEqual(snapshot(root), before);
});

test('单场景源/数组聚合与精选层级独立读取，无关场景失配不误报', (t) => {
  const { write, scenes, run } = sceneFixture(t);
  write('data/scenes.json', [scenes[0], scenes[1], { ...scenes[2], extra: true }]);
  const r = run(['--scene', 'sc001']);
  assert.deepEqual(r.mustChange, []);
  assert.deepEqual(r.scenes.map((s: any) => s.id), ['sc001']);
  assert.deepEqual(r.scenes[0].sources, [{ file: 'data/scenes/base.1.json', group: 'data/scenes/base.json' }]);
  assert.equal(r.scenes[0].aggregate.status, 'current');
  assert.deepEqual(r.scenes[0].curation, { curatedSceneIds: 'included', signatureSceneIds: 'not-listed', personaCoreSceneIds: 'included' });
  assert.equal(run(['--scene', 'sc002']).scenes[0].curation.signatureSceneIds, 'included');
  assert.ok(!JSON.stringify(r.mustChange).includes('sc003'));
});

test('逻辑组展开所有批次，实际路径精确匹配，删除/重命名及聚合路径未知', (t) => {
  const { run } = sceneFixture(t);
  assert.deepEqual(run(['--path', 'data/scenes/base.json']).scenes.map((s: any) => s.id), ['sc001', 'sc002']);
  assert.deepEqual(run(['--path', 'data/scenes/base.2.json']).scenes.map((s: any) => s.id), ['sc002']);
  for (const file of ['base.20.json', 'removed.json', 'manifest.json']) {
    const r = run(['--path', `data/scenes/${file}`]);
    assert.deepEqual(r.scenes, []);
    assert.ok(r.unknown.some((s: any) => s.includes(file)));
  }
  assert.deepEqual(run(['--path', 'data/scenes.json']).scenes, []);
  assert.ok(run(['--path', 'data/scenes/base.1.json']).unknown.some((s: any) => s.includes('历史删除/重命名')));
});

test('退役登记、活跃冲突与悬空精选分别报告，不推断历史源', (t) => {
  const { run, write } = sceneFixture(t);
  const retired = run(['--scene', 'sc099']);
  assert.equal(retired.scenes[0].retirement.status, 'retired');
  assert.deepEqual(retired.scenes[0].sources, []);
  assert.deepEqual(retired.mustChange, []);
  assert.ok(retired.unknown.some((s: any) => s.includes('sc099')));
  write('data/retired-scenes.json', { records: [{ id: 'sc001' }] });
  assert.ok(run(['--scene', 'sc001']).mustChange.some((s: any) => s.reason.includes('活跃/退役')));
  write('data/curation.json', { curatedSceneIds: ['sc098'], signatureSceneIds: [], personaCoreSceneIds: [] });
  assert.ok(run(['--scene', 'sc098']).mustChange.some((s: any) => s.reason.includes('悬空')));
});

test('聚合缺失、失配、重复及残留均由目标记录证明', (t) => {
  const { run, write, scenes } = sceneFixture(t);
  for (const [values, status] of [[[], 'missing'], [[{ ...scenes[0], extra: 1 }], 'mismatch'], [[scenes[0], scenes[0]], 'duplicate']]) {
    write('data/scenes.json', values);
    const r = run(['--scene', 'sc001']);
    assert.equal(r.scenes[0].aggregate.status, status);
    assert.ok(r.recommendations.some((s: any) => s.name === 'data:build' && s.executed === false));
  }
  write('data/scenes.json', [{ id: 'sc098' }]);
  assert.equal(run(['--scene', 'sc098']).scenes[0].aggregate.status, 'stale');
});

test('批次缺号、并存和未登记文件不能证明完整源边界', (t) => {
  const { run, write } = sceneFixture(t);
  write('data/scenes/base.4.json', [{ id: 'sc004' }]);
  const gap = run(['--path', 'data/scenes/base.json']);
  assert.deepEqual(gap.scenes, []);
  assert.ok(gap.mustChange.some((s: any) => s.reason.includes('缺号')));
  write('data/scenes/base.json', []);
  assert.ok(run(['--scene', 'sc001']).mustChange.some((s: any) => s.reason.includes('并存')));
  write('data/scenes/unmanaged.json', [{ id: 'sc005' }]);
  assert.equal(run(['--scene', 'sc003']).scenes[0].sourceStatus, 'unknown');
});

test('场景 CLI/工作流、帮助、预览与错误路径均零写入', (t) => {
  const { root } = sceneFixture(t);
  const before = snapshot(root);
  const script = path.resolve(__dirname, '../maintenance/report-content-impact.js');
  const workflow = path.resolve(__dirname, '../workflow.js');
  for (const prefix of [[script], [workflow, 'audit:impact']]) {
    const r = spawnSync(process.execPath, [...prefix, '--root', root, '--scene', 'sc001', '--json'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.equal(JSON.parse(r.stdout).scenes[0].id, 'sc001');
    for (const flag of ['--help', '--plan']) assert.equal(spawnSync(process.execPath, [...prefix, '--root', path.join(root, 'missing'), flag]).status, 0);
  }
  for (const args of [['--scene', 'bad'], ['--scene', 'sc001', '--scene', 'sc002'], ['--path', 'data/scenes/../outside.json']]) assert.throws(() => parse(args));
  assert.deepEqual(snapshot(root), before);
});
test('样张 scene/character 精确匹配与安全 review 元数据，不输出图片或审核内容', (t) => {
  const { root, write, run } = sceneFixture(t);
  write('showcase.json', { entries: [
    { id: 'sc001', char: 'b', type: 'scene', rating: 'safe', attempt: 2, image: '../secret.png', provenance: { review: { secret: 'private-review' } } },
    { id: 'other', char: 'a', provenance: { review: null } },
    { id: 'typed', type: 'a', rating: { secret: true } },
    { id: 'unrelated', char: 'aa', type: 'b' },
  ] });
  const scene = run(['--scene', 'sc001', '--showcase-manifest', 'showcase.json']);
  assert.deepEqual(scene.showcase.manifests[0].entries, [{ index: 0, id: 'sc001', type: 'scene', char: 'b', rating: 'safe', attempt: 2, reviewPresent: true, matchedBy: ['scene'] }]);
  const r = report(options(root, { showcaseManifests: ['showcase.json'] }));
  assert.deepEqual(r.showcase.manifests[0].entries.map((e: any) => [e.id, e.reviewPresent]), [['other', true], ['typed', false]]);
  assert.equal(r.showcase.manifests[0].entries[1].rating, null);
  for (const level of ['related', 'revalidate']) assert.equal(r[level].filter((e: any) => e.domain === 'showcase').length, 2);
  assert.doesNotMatch(JSON.stringify(r.showcase), /secret|private-review|image/);
  assert.deepEqual(r.mustChange, []);
});

test('未提供或部分/空清单不证明样张缺失，多清单保留各自来源', (t) => {
  const { root, write } = fixture(t);
  const r = report(options(root));
  assert.equal(r.showcase.status, 'unknown');
  assert.ok(r.unknown.includes('样张清单在外部/未提供'));
  write('one.json', { entries: [] });
  write('two.json', { entries: [{ id: 'other', char: 'b' }] });
  const args = parse(['--root', root, '--character', 'a', '--showcase-manifest', 'one.json', '--showcase-manifest', 'two.json']);
  const partial = report(args);
  assert.equal(partial.showcase.status, 'partial');
  assert.equal(partial.showcase.manifests.length, 2);
  assert.deepEqual(partial.mustChange, []);
  assert.ok(partial.showcase.manifests.every((m: any) => m.entries.length === 0));
});

test('缺失、目录、坏 JSON/entries 清单 fail-closed，混合清单保留有效关联', (t) => {
  const { root, write } = fixture(t);
  write('good.json', { entries: [{ id: 'match', char: 'a' }] });
  for (const value of [null, {}, { entries: {} }, { entries: [null] }, { entries: [{ id: 'x', char: {} }] }]) {
    write('bad.json', value);
    const r = report(options(root, { showcaseManifests: ['good.json', 'bad.json'] }));
    assert.equal(r.showcase.status, 'error');
    assert.equal(r.showcase.manifests[1].entries.length, 0);
    assert.equal(r.showcase.manifests[0].entries.length, 1);
    assert.deepEqual(r.mustChange.map((e: any) => e.domain), ['showcase-manifest']);
  }
  fs.writeFileSync(path.join(root, 'bad.json'), '{');
  for (const file of ['missing.json', 'data', 'bad.json', '../outside.json']) {
    const r = report(options(root, { showcaseManifests: [file] }));
    assert.equal(r.showcase.status, 'error');
    assert.deepEqual(r.showcase.manifests[0].entries, []);
  }
});

test('manifest junction 越界不读取外部文件，CLI 拒绝绝对及父路径', (t) => {
  const f = fixture(t);
  const outside = fixture(t);
  outside.write('secret.json', { entries: [{ id: 'x', char: 'a' }] });
  fs.symlinkSync(outside.root, path.join(f.root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  const before = snapshot(outside.root);
  const r = report(options(f.root, { showcaseManifests: ['escape/secret.json'] }));
  assert.equal(r.showcase.status, 'error');
  assert.match(r.showcase.manifests[0].reason, /超出/);
  assert.deepEqual(r.showcase.manifests[0].entries, []);
  assert.deepEqual(snapshot(outside.root), before);
  for (const file of ['../outside.json', 'C:/outside.json', '/outside.json']) assert.throws(() => parse(['--character', 'a', '--showcase-manifest', file]));
});

test('样张 CLI/工作流成功、错误、帮助预览零写入，图片引用不访问', (t) => {
  const { root, write } = fixture(t);
  write('showcase.json', { entries: [{ id: 'x', char: 'a', image: '/missing/image.png' }] });
  const before = snapshot(root);
  for (const prefix of [[path.resolve(__dirname, '../maintenance/report-content-impact.js')], [path.resolve(__dirname, '../workflow.js'), 'audit:impact']]) {
    const args = [...prefix, '--root', root, '--character', 'a', '--showcase-manifest'];
    for (const [file, status] of [['showcase.json', 0], ['absent.json', 1], ['../escape.json', 2]]) {
      const r = spawnSync(process.execPath, [...args, file, '--json'], { encoding: 'utf8' });
      assert.equal(r.status, status, r.stdout || r.stderr);
      const value = JSON.parse(r.stdout);
      if (!status) assert.equal(value.showcase.manifests[0].entries[0].id, 'x');
    }
    assert.match(spawnSync(process.execPath, [...args, 'showcase.json'], { encoding: 'utf8' }).stdout, /showcase:/);
    for (const flag of ['--help', '--plan']) assert.equal(spawnSync(process.execPath, [...prefix, '--root', path.join(root, 'missing'), '--showcase-manifest', 'absent.json', flag]).status, 0);
  }
  assert.deepEqual(snapshot(root), before);
});

function snapshot(root: any) {
  return fs.readdirSync(root, { recursive: true }).sort().filter((f) => fs.statSync(path.join(root, f)).isFile()).map((f) => [f, fs.readFileSync(path.join(root, f), 'hex')]);
}
test('服装按角色作用域过滤；报告不写入，推荐只来自注册表', (t) => {
  const { root } = fixture(t);
  const before = snapshot(root);
  const result = report(options(root, { outfit: 'dress' }));
  assert.deepEqual(result.mustChange, []);
  assert.deepEqual(result.revalidate.filter((r: any) => r.domain === 'blueprint').map((r: any) => r.object), ['data/blueprints/one.json#a1']);
  assert.ok(result.revalidate.some((r: any) => r.domain === 'reference'));
  assert.ok(result.recommendations.every((r: any) => !r.executed));
  assert.deepEqual(snapshot(root), before);
});
test('悬空引用和旧聚合明确报告；不要求无关系列重写', (t) => {
  const { root, write, blueprints } = fixture(t);
  blueprints[0].outfitId = 'removed';
  write('data/blueprints/one.json', { blueprints });
  const r = report(options(root, { outfit: 'removed' }));
  assert.ok(r.mustChange.some((x: any) => x.reason.includes('悬空')));
  assert.ok(r.mustChange.some((x: any) => x.reason.includes('失配')));
  assert.ok(!r.mustChange.some((x: any) => x.object.endsWith('#b1')));
});
test('路径输入保守匹配分片，删除路径和公共构建器不假定增量安全', (t) => {
  const { root } = fixture(t);
  const r = report(options(root, { character: null, paths: ['data/popular/one.json', 'data/popular/deleted.json', 'scripts/maintenance/build-popular.js'] }));
  assert.equal(r.related.filter((x: any) => x.domain === 'popular').length, 2);
  assert.ok(r.unknown.some((s: any) => s.includes('deleted.json')));
  assert.ok(r.recommendations.some((x: any) => x.name === 'data:validate'));
});
test('损坏清单/重复身份不能回退旧产物冒充完整', (t) => {
  const { root, write, characters } = fixture(t);
  characters[1].id = 'a';
  write('data/popular/one.json', { characters });
  assert.ok(report(options(root)).mustChange.some((r: any) => r.reason.includes('重复 ID')));
  write('data/popular/manifest.json', { files: [{ file: '../escape.json', count: 1 }] });
  const r = report(options(root));
  assert.ok(r.unknown.some((s: any) => s.includes('不完整')));
  assert.equal(r.related.filter((x: any) => x.domain === 'popular').length, 0);
});
test('参数拒绝未知开关、越界与无角色服装', () => {
  for (const args of [[], ['--outfit', 'x'], ['--path', '../x'], ['--path', 'C:/x'], ['--character'], ['--write']]) assert.throws(() => parse(args));
  assert.deepEqual(parse(['--path', 'data\\popular\\one.json']).paths, ['data/popular/one.json']);
});
test('直接 CLI 帮助/预览不读数据；JSON 成功及错误退出码', (t) => {
  const { root } = fixture(t);
  const script = path.resolve(__dirname, '../maintenance/report-content-impact.js');
  for (const flag of ['--help', '--plan']) assert.equal(spawnSync(process.execPath, [script, flag, '--root', path.join(root, 'missing')]).status, 0);
  const before = snapshot(root);
  const ok = spawnSync(process.execPath, [script, '--root', root, '--character', 'a', '--json'], { encoding: 'utf8' });
  assert.equal(ok.status, 0);
  assert.equal(JSON.parse(ok.stdout).readOnly, true);
  const viaWorkflow = spawnSync(process.execPath, [path.resolve(__dirname, '../workflow.js'), 'audit:impact', '--root', root, '--character', 'a', '--json'], { encoding: 'utf8' });
  assert.equal(viaWorkflow.status, 0);
  assert.equal(JSON.parse(viaWorkflow.stdout).readOnly, true);
  const bad = spawnSync(process.execPath, [script, '--json', '--write'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.ok(JSON.parse(bad.stdout).error);
  assert.deepEqual(snapshot(root), before);
});
// G8：人类可读输出。formatImpactReport 只排版 report() 既有结果，不产生新判定。
test('G8 三分级条目保留 domain/object/reason，未知与未执行建议独立呈现', () => {
  const out = formatImpactReport({
    version: 1, readOnly: true,
    input: { character: 'a', outfit: 'dress', scene: null, paths: ['data/popular/one.json'] },
    mustChange: [{ domain: 'theme', object: 'src/assets/css/director/tokens.css#a', reason: 'canonical 角色缺少显式主题，且不在默认主题白名单' }],
    revalidate: [{ domain: 'blueprint', object: 'data/blueprints/one.json#a1', reason: '显式角色/服装引用；需复核编译和画面，未执行' }],
    related: [{ domain: 'popular', object: 'data/popular/one.json#a', reason: '权威身份/服装源；关联不等于必须重写' }],
    unknown: ['b: 主题 unknown；外部热门角色'],
    recommendations: [{ name: 'data:validate', argv: ['node', 'scripts/workflow.js', 'data:validate'], nature: ['read-only'], executed: false }],
  });
  assert.ok(out.startsWith('只读影响报告'), out);
  assert.ok(out.includes('目标: 角色 a · 服装 dress · 路径 1 个: data/popular/one.json'));
  assert.ok(out.includes('必改 1 ｜ 需复验 1 ｜ 仅关联 1 ｜ 未知 1 条 ｜ 建议命令 1（未执行）'));
  assert.ok(out.includes('必改 mustChange: 1 条'));
  assert.ok(out.includes('[theme] src/assets/css/director/tokens.css#a — canonical 角色缺少显式主题'));
  assert.ok(out.includes('需复验 revalidate: 1 条'));
  assert.ok(out.includes('[blueprint] data/blueprints/one.json#a1 — 显式角色/服装引用'));
  assert.ok(out.includes('仅关联 related: 1 条'));
  assert.ok(out.includes('[popular] data/popular/one.json#a — 权威身份/服装源；关联不等于必须重写'));
  assert.ok(out.includes('未知范围 unknown: 1 条'));
  assert.ok(out.includes('- b: 主题 unknown'));
  assert.ok(out.includes('未执行推荐命令 recommendations: 1 条'));
  assert.ok(out.includes('data:validate（nature: read-only）: node scripts/workflow.js data:validate'));
  assert.ok(!out.includes('{"') && !out.includes('[{'), '不得残留整段 JSON');
});
test('G8 空集合整节省略，只剩目标与摘要行', () => {
  const out = formatImpactReport({ version: 1, readOnly: true, input: { character: null, outfit: null, scene: null, paths: [] }, mustChange: [], revalidate: [], related: [], unknown: [], recommendations: [] });
  for (const banned of ['必改 mustChange', '需复验 revalidate', '仅关联 related', '未知范围 unknown', '未执行推荐命令 recommendations', 'Git 变更', '默认服装', '参考状态', '主题 themes', '场景 scenes', '样张 showcase', '{"', '[{']) assert.ok(!out.includes(banned), banned);
  assert.ok(out.includes('必改 0 ｜ 需复验 0 ｜ 仅关联 0 ｜ 未知 0 条 ｜ 建议命令 0（未执行）'));
  assert.ok(out.includes('未指定显式目标'));
});
test('G8 参考状态区分 pending/URL 声明/存在性未知，服装主题场景样张短行保留定位', () => {
  const out = formatImpactReport({
    input: { character: 'a', outfit: 'dress', scene: 'sc001', paths: [] },
    outfitDefaults: [{ id: 'a', status: 'explicit', defaultOutfit: 'coat', defaultIds: ['coat'], isDefaultIds: ['coat'], reasons: ['两字段集合一致，恰好一个默认项且 ID 唯一有效'] }],
    referenceEvidence: [
      { characterId: 'a', outfitId: 'dress', status: 'pending', total: 3, pendingCount: 2, urlDeclaredCount: 2, reviewDeclaredCount: 1, reviewStatus: 'declared-unverified', assetStatus: 'unverified', reason: '仅统计索引声明' },
      { characterId: 'b', outfitId: null, status: 'empty', total: 0, pendingCount: 0, urlDeclaredCount: 0, reviewDeclaredCount: 0, reviewStatus: 'unknown', assetStatus: 'unverified', reason: '仅统计索引声明' },
      { characterId: 'c', outfitId: null, status: 'missing', total: null, pendingCount: null, urlDeclaredCount: null, reviewDeclaredCount: null, reviewStatus: 'unknown', assetStatus: 'unverified', reason: '角色未登记' },
    ],
    themes: [{ id: 'a', file: 'src/assets/css/director/tokens.css', canonical: true, themeStatus: 'explicit', selector: '[data-character="a"]', reason: '当前 CSS 有显式角色选择器' }],
    scenes: [{ id: 'sc001', sourceStatus: 'present', sources: [{ file: 'data/scenes/base.1.json', group: 'data/scenes/base.json' }], aggregate: { file: 'data/scenes.json', status: 'current' }, curation: { curatedSceneIds: 'included', signatureSceneIds: 'not-listed', personaCoreSceneIds: 'not-listed' }, retirement: { status: 'not-listed', records: [] } }],
    showcase: { status: 'partial', manifests: [{ file: 'showcase.json', status: 'parsed', entries: [{ index: 0, id: 'sc001', type: 'scene', char: 'a', rating: 'safe', attempt: 2, reviewPresent: true, matchedBy: ['scene'] }] }] },
    mustChange: [], revalidate: [], related: [], unknown: [], recommendations: [],
  });
  assert.ok(out.includes('a/dress: pending · 共 3 条 · pending 2、URL 声明 2、review 声明 1 · review: declared-unverified · 素材存在性: unverified'), out);
  assert.ok(out.includes('b/*: empty'));
  assert.ok(out.includes('c/*: missing'));
  assert.ok(out.includes('a: explicit（默认 coat'));
  assert.ok(out.includes('a: explicit [data-character="a"]'));
  assert.ok(out.includes('sc001: 源 present: data/scenes/base.1.json · 聚合 current（data/scenes.json） · 精选 curatedSceneIds=included, signatureSceneIds=not-listed, personaCoreSceneIds=not-listed · 退役 not-listed'));
  assert.ok(out.includes('#0 sc001 · type=scene · char=a · rating=safe · attempt=2 · review 字段已声明 · 命中: scene'));
});
test('G8 超长列表截断并注明剩余数量与 --json 入口', () => {
  const related = Array.from({ length: 100 }, (_, i) => ({ domain: 'x', object: `data/x.json#item${i}`, reason: 'r' }));
  const out = formatImpactReport({ input: { paths: Array.from({ length: 8 }, (_, i) => `data/${i}.json`) }, mustChange: [], revalidate: [], related, unknown: [], recommendations: [] });
  assert.ok(out.includes('其余 3 个见 --json'));
  assert.ok(out.includes('仅关联 related: 100 条'));
  assert.ok(out.includes('item0'));
  assert.ok(!out.includes('item99'), '截断后不得输出全部条目');
  const note = out.match(/其余 (\d+) 条见 --json/);
  const shown = (out.match(/#item\d+/g) || []).length;
  assert.ok(note, '须注明剩余数量');
  assert.equal(Number(note[1]), 100 - shown);
});
test('G8 异常兜底：非对象报告与怪异条目不抛错、不冒充可读结果', () => {
  const circular = {}; circular.self = circular;
  for (const input of [null, undefined, 42, 'x', []]) {
    const out = formatImpactReport(input);
    assert.equal(typeof out, 'string');
    assert.ok(out.includes('--json'), '非对象兜底输出须指向 --json');
  }
  assert.equal(typeof formatImpactReport(circular), 'string');
  const garbage = {
    input: { paths: 'not-array', character: 5 },
    mustChange: [null, 7, { object: null, reason: { deep: true } }, { domain: '', object: 'x' }],
    revalidate: 'nope', related: [{ domain: 'd' }], unknown: [null, { a: 1 }],
    recommendations: [{ name: '' }, { argv: 'node x' }],
    outfitDefaults: [null, { status: 'explicit' }],
    referenceEvidence: [{ characterId: 'a' }],
    themes: [{ id: 'a' }],
    scenes: [{ id: 'sc001', sources: 'bad', aggregate: null, curation: [], retirement: null }],
    showcase: { status: 'error', manifests: [{ file: 'f', status: 'error' }] },
    gitChanges: 42,
  };
  const out = formatImpactReport(garbage);
  assert.equal(typeof out, 'string');
  assert.ok(out.length > 0);
  assert.ok(out.includes('必改 mustChange: 4 条'));
  assert.ok(out.includes('[无域] （无对象）'));
  assert.ok(!out.includes('需复验 revalidate:'), '非数组 revalidate 视为空集合');
  assert.ok(out.includes('场景 scenes: 1 项'));
  assert.ok(out.includes('sc001: 源 unknown'));
});
test('G8 格式化不修改报告对象；CLI 文本与 --json 同源且退出码一致，零写入', (t) => {
  const f = themeFixture(t, '.pb { color: red; }');
  const args = ['--root', f.root, '--character', 'a', '--outfit', 'dress'];
  const original = report(parse(args));
  const clone = JSON.parse(JSON.stringify(original));
  const formatted = formatImpactReport(original);
  assert.deepEqual(original, clone, '格式化不得修改报告对象');
  assert.ok(formatted.includes('[theme] src/assets/css/director/tokens.css#a'), '缺主题为必改');
  const before = snapshot(f.root);
  const script = path.resolve(__dirname, '../maintenance/report-content-impact.js');
  const jsonRun = spawnSync(process.execPath, [script, ...args, '--json'], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(jsonRun.stdout), clone, 'CLI --json 与 report() 同源');
  const textRun = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  assert.equal(textRun.status, jsonRun.status, '文本与 JSON 退出码一致');
  assert.equal(textRun.status, 1);
  assert.ok(textRun.stdout.includes('必改 mustChange: 1 条'));
  assert.ok(textRun.stdout.includes('[theme] src/assets/css/director/tokens.css#a'));
  const ok = themeFixture(t, '[data-character="a"] { color: red; }');
  const okArgs = ['--root', ok.root, '--character', 'a'];
  const okJson = spawnSync(process.execPath, [script, ...okArgs, '--json'], { encoding: 'utf8' });
  assert.equal(okJson.status, 0);
  const okText = spawnSync(process.execPath, [script, ...okArgs], { encoding: 'utf8' });
  assert.equal(okText.status, 0);
  assert.ok(okText.stdout.includes('必改 0 ｜ 需复验'));
  assert.ok(okText.stdout.includes('a: explicit [data-character="a"]'));
  assert.ok(!okText.stdout.includes('必改 mustChange:'));
  assert.deepEqual(snapshot(f.root), before);
});
