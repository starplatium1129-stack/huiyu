'use strict';

/**
 * test-coverage-report.js — audit:coverage 差额报告的隔离夹具测试。
 *
 * 覆盖主任务交接要求的验收点：双方 ID 集合差额、缺文件、重复 ID、缺批号
 * （manifest 批次数不符）、结果可复跑；全部使用临时夹具，不触碰生产 data/。
 * 运行：node --test scripts/tests/test-coverage-report.js
 */

const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { test }: typeof import('node:test') = require('node:test');
const fs: typeof import('node:fs') = require('node:fs');
const os: typeof import('node:os') = require('node:os');
const path: typeof import('node:path') = require('node:path');
const { spawnSync }: typeof import('node:child_process') = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const REPORT = path.join(ROOT, 'scripts', 'maintenance', 'report-content-coverage.js');
const {
  analyseThemes, analyseReferences, extractThemeSelectors, normalizeAlias,
  popularAliasMapOf, buildReport, makeFileExists, DEFAULT_THEME_ALLOWED,
}: typeof import('../maintenance/report-content-coverage') = require('../maintenance/report-content-coverage');
const {
  parseSelectionArgs,
  collectScopedRefUrls, scopeFileExists, filterReportToScope,
}: typeof import('../lib/coverage-selection') = require('../lib/coverage-selection');

function writeJson(file: any, value: any) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

/** 标准夹具：char_x(o1 已登记有图/o2 已登记缺图/o3 pending/o9 未登记)、
 *  char_y(o4 未登记)、char_k(旧别名宿主)、nene(默认主题)。 */
function makeBaseFixture(dir: any) {
  const popularA = {
    version: 1, franchise: 'A',
    characters: [
      { id: 'char_x', displayName: 'X', aliases: [], outfits: [{ id: 'o1' }, { id: 'o2' }, { id: 'o3' }, { id: 'o9' }] },
      { id: 'char_y', displayName: 'Y', aliases: [], outfits: [{ id: 'o4' }] },
    ],
  };
  const popularB = {
    version: 1, franchise: 'B',
    characters: [{ id: 'char_k', displayName: 'Historia Reiss', aliases: ['historia reiss', 'krista'], outfits: [{ id: 'k1' }] }],
  };
  writeJson(path.join(dir, 'data/popular/manifest.json'), {
    version: 1,
    files: [
      { file: 'a.json', franchise: 'A', count: popularA.characters.length },
      { file: 'b.json', franchise: 'B', count: popularB.characters.length },
    ],
  });
  writeJson(path.join(dir, 'data/popular/a.json'), popularA);
  writeJson(path.join(dir, 'data/popular/b.json'), popularB);
  writeJson(path.join(dir, 'data/characters.json'), [
    { id: 'char_x', accent_color: '#ff0000' },
    { id: 'char_y', accent_color: null },
    { id: 'nene', accent_color: '#00ff00' },
  ]);
  writeJson(path.join(dir, 'data/character-reference-standards.json'), {
    version: 1, perspectives: [],
    characters: [
      { id: 'char_x', outfits: [{ id: 'o1' }, { id: 'o2' }, { id: 'o3' }, { id: 'ghost_form' }] },
      { id: 'nene', outfits: [{ id: 'witch_canonical' }] },
    ],
  });
  writeJson(path.join(dir, 'data/character-reference-view.json'), {
    char_x: {
      outfits: [
        { outfitId: 'o1', references: [{ id: 'ref_a', url: '/character-references/char_x/o1/ref_a.png', pending: false }] },
        { outfitId: 'o2', references: [{ id: 'ref_a', url: '/character-references/char_x/o2/ref_a.png', pending: false }] },
        { outfitId: 'o3', references: [{ id: 'ref_a', url: '', pending: true }] },
        { outfitId: 'ghost_form', references: [{ id: 'ref_a', url: '', pending: true }] },
      ],
    },
    nene: { outfits: [{ outfitId: 'witch_canonical', references: [{ id: 'ref_a', url: '', pending: true }] }] },
  });
  fs.mkdirSync(path.join(dir, 'src/assets/css/director'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/assets/css/director/tokens.css'), [
    '.pb[data-character="char_x"],',
    '.pb[data-character="historia_reiss"],',
    '.pb[data-character="triad"] { color: red; }',
  ].join('\n'));
  return dir;
}

function loadFixtureData(dir: any) {
  const readJson = (file: any) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  const manifest = readJson('data/popular/manifest.json');
  const sources = manifest.files.map((entry: any) => ({
    entry,
    characters: readJson(path.join('data/popular', entry.file)).characters,
  }));
  const rows = sources.flatMap(({ entry, characters }: any) =>
    characters.flatMap((character: any) => (character.outfits || []).map((outfit: any) => ({ id: character.id, outfitId: outfit.id, file: entry.file }))));
  const standards = readJson('data/character-reference-standards.json').characters
    .map((c: any) => ({ id: c.id, outfitIds: c.outfits.map((o: any) => o.id) }));
  const view = Object.entries(readJson('data/character-reference-view.json')).map(([id, profile]: any) => ({
    id,
    outfits: profile.outfits.map((o: any) => ({ outfitId: o.outfitId, references: o.references })),
  }));
  return { sources, rows, standards, view, characters: readJson('data/characters.json') };
}

test('theme classification separates explicit, default-allowed, missing, stale-alias and non-character', () => {
  assert.deepEqual(extractThemeSelectors('.pb[data-character="a"],\n.pb[data-character="b"] { }'), ['a', 'b']);
  const themes = analyseThemes({
    characters: [{ id: 'a' }, { id: 'b' }, { id: 'nene' }, { id: 'c' }],
    selectors: ['a', 'ghost', 'triad'],
    popularAliasMap: new Map([['ghost', 'char_k']]),
  });
  assert.deepEqual(themes.explicit, ['a']);
  assert.deepEqual(themes.defaultAllowed, ['nene']);
  assert.deepEqual(themes.missingTheme.map((row) => row.id).sort(), ['b', 'c']);
  assert.deepEqual(themes.staleAlias, [{ selector: 'ghost', suggestion: 'char_k', matchType: 'alias', note: '待人工确认后改名，不改语义' }]);
  assert.deepEqual(themes.nonCharacter.map((row) => row.selector), ['triad']);
  assert.equal(normalizeAlias('Historia Reiss!'), 'historia_reiss');
  assert.deepEqual(DEFAULT_THEME_ALLOWED, ['nene']);
});

test('reference analysis separates missing registration, pending, missing image and unverified', () => {
  const popular = [
    { id: 'a', outfitId: 'gone', file: 'p.json' },
    { id: 'a', outfitId: 'shot', file: 'p.json' },
    { id: 'a', outfitId: 'draft', file: 'p.json' },
  ];
  const standards = [{ id: 'a', outfitIds: ['shot', 'draft', 'phantom'] }];
  const view = [{
    id: 'a',
    outfits: [
      { outfitId: 'shot', references: [{ id: 'r', url: '/character-references/a/shot/r.png', pending: false }] },
      { outfitId: 'draft', references: [{ id: 'r', url: '', pending: true }] },
      { outfitId: 'phantom', references: [{ id: 'r', url: '', pending: true }] },
    ],
  }];
  const exists = (url: any) => (url.includes('shot') ? true : url.includes('gone') ? false : null);
  const result = analyseReferences({ popular, standards, view, fileExists: exists });
  assert.deepEqual(result.missingRegistration, [{ id: 'a', outfitId: 'gone', source: 'p.json', related: 'data/character-reference-standards.json 无此形态' }]);
  assert.deepEqual(result.pending, [{ id: 'a', outfitId: 'draft', source: 'data/character-reference-view.json', pending: 1, total: 1 }]);
  assert.equal(result.verifiedImage, 1);
  assert.deepEqual(result.missingImage, []);
  // standards 独有形态单列，不混入 popular 差额。
  assert.deepEqual(result.referenceOnlyForms, [{ id: 'a', outfitId: 'phantom', note: 'standards 独有形态；来源与必要性待核实，不自动删除' }]);
  // null（无法核实）不冒充缺图也不冒充在位。
  const unverifiedOnly = analyseReferences({
    popular: [{ id: 'a', outfitId: 'shot', file: 'p.json' }],
    standards, view, fileExists: () => null,
  });
  assert.equal(unverifiedOnly.unverifiedImage.length, 1);
  assert.equal(unverifiedOnly.verifiedImage, 0);
  assert.equal(unverifiedOnly.missingImage.length, 0);
});

test('structural errors: duplicate ids, broken mirror, and manifest count mismatch via CLI', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-coverage-'));
  try {
    makeBaseFixture(dir);
    // 跨文件重复角色 + 重复服装。
    const shardB = JSON.parse(fs.readFileSync(path.join(dir, 'data/popular/b.json'), 'utf8'));
    shardB.characters.push({ id: 'char_x', outfits: [{ id: 'o1' }] });
    fs.writeFileSync(path.join(dir, 'data/popular/b.json'), JSON.stringify(shardB));
    // standards↔view 镜像破坏：standards 多出 view 没有的形态。
    const standards = JSON.parse(fs.readFileSync(path.join(dir, 'data/character-reference-standards.json'), 'utf8'));
    standards.characters[0].outfits.push({ id: 'mirror_drift' });
    fs.writeFileSync(path.join(dir, 'data/character-reference-standards.json'), JSON.stringify(standards));

    const data = loadFixtureData(dir);
    const report = buildReport({
      characters: data.characters,
      popularRows: data.rows,
      standards: data.standards,
      view: data.view,
      selectors: [],
      popularAliasMap: popularAliasMapOf(data.sources.flatMap(({ characters }: any) => characters)),
      fileExists: () => null,
    });
    assert.ok(report.structuralErrors.some((message) => message.includes('热门分片跨文件重复角色 ID: char_x')), '未报告跨文件重复角色');
    assert.ok(report.structuralErrors.some((message) => message.includes('重复服装 ID: char_x/o1')), '未报告重复服装');
    assert.ok(report.structuralErrors.some((message) => message.includes('镜像破坏') && message.includes('mirror_drift')), '未报告镜像破坏');

    // CLI：manifest 批次数不符（缺批号变体）→ 退出 1。
    const manifestPath = path.join(dir, 'data/popular/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.files[0].count = 99;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const result = spawnSync(process.execPath, [REPORT, '--json', '--root', dir], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    assert.equal(result.status, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI reports coverage gaps as exit 0 and is deterministic across reruns', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-coverage-'));
  try {
    makeBaseFixture(dir);
    const run = () => spawnSync(process.execPath, [REPORT, '--json', '--root', dir], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    const first = run();
    assert.equal(first.status, 0, `覆盖率差额不应导致失败：${first.stderr}`);
    const parsed = JSON.parse(first.stdout);
    assert.deepEqual(parsed.reference.missingRegistration.map((row: any) => `${row.id}/${row.outfitId}`).sort(),
      ['char_k/k1', 'char_x/o9', 'char_y/o4'].sort());
    const pendingRow = parsed.reference.pending.find((row: any) => row.id === 'char_x' && row.outfitId === 'o3');
    assert.equal(pendingRow.pending, 1);
    const stale = parsed.themes.staleAlias.find((row: any) => row.selector === 'historia_reiss');
    assert.equal(stale.suggestion, 'char_k');
    assert.deepEqual(parsed.themes.missingTheme.map((row: any) => row.id).sort(), ['char_y']);
    assert.deepEqual(parsed.themes.defaultAllowed, ['nene']);
    // 结果可复跑：两次输出逐字节一致。
    const second = run();
    assert.equal(second.stdout, first.stdout);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('missing shard file and unparseable source surface as structural exit 1', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-coverage-'));
  try {
    makeBaseFixture(dir);
    fs.rmSync(path.join(dir, 'data/popular/b.json'));
    const result = spawnSync(process.execPath, [REPORT, '--json', '--root', dir], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes('结构错误'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fileExists distinguishes real missing image from absent reference root', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-coverage-'));
  try {
    const refRoot = path.join(dir, 'fake-ref-root');
    const exists = makeFileExists({ appRoot: dir, env: { AICS_CHARACTER_REF_ROOT: refRoot } });
    // 素材根不存在 → 无法核实（null），不冒充缺图。
    assert.equal(exists('/character-references/a/b/ref_01.png'), null);
    assert.equal(exists('/character-references/../escape.png'), false);
    assert.equal(exists('/character-references/a%3Fb.png'), false);
    assert.equal(exists('/character-references/'), false);
    // 素材根存在 → 逐文件判定。
    fs.mkdirSync(refRoot, { recursive: true });
    assert.equal(exists('/character-references/a/b/ref_01.png'), false);
    fs.mkdirSync(path.join(refRoot, 'a', 'b'), { recursive: true });
    fs.writeFileSync(path.join(refRoot, 'a', 'b', 'ref_01.png'), 'png');
    assert.equal(exists('/character-references/a/b/ref_01.png'), true);
    // 越界路径拒绝。
    assert.equal(exists('/character-references/../escape.png'), false);
    // 非参考前缀 → 走 assetsRoot（仓库内 assets）。
    assert.equal(exists('/assets/unknown.png'), null);
    fs.mkdirSync(path.join(dir, 'assets'));
    assert.equal(exists('/assets/unknown.png'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mixed pending and completed references still audit every completed image', () => {
  const result = analyseReferences({
    popular: [{ id: 'a', outfitId: 'o', file: 'a.json' }],
    standards: [{ id: 'a', outfitIds: ['o'] }],
    view: [{ id: 'a', outfits: [{ outfitId: 'o', references: [
      { id: 'draft', pending: true, url: '/assets/draft.png' },
      { id: 'empty', url: '' },
      { id: 'ok', url: '/assets/ok.png' },
      { id: 'missing', url: '/assets/missing.png' },
      { id: 'offline', url: '/assets/offline.png' },
    ] }] }],
    fileExists: (url: any) => url.includes('ok') ? true : url.includes('missing') ? false : null,
  });
  assert.equal(result.pending[0].pending, 2);
  assert.equal(result.verifiedImage, 1);
  assert.deepEqual(result.missingImage.map((r) => r.refId), ['missing']);
  assert.deepEqual(result.unverifiedImage.map((r) => r.refId), ['offline']);
});

test('duplicate registrations are structural errors before Map/Set normalization', () => {
  const report = buildReport({
    characters: [], popularRows: [], selectors: [], popularAliasMap: new Map(), fileExists: () => null,
    standards: [{ id: 'a', outfitIds: ['o', 'o'] }, { id: 'a', outfitIds: ['o'] }],
    view: [{ id: 'a', outfits: [{ outfitId: 'o' }, { outfitId: 'o' }] }],
  });
  assert.equal(report.reference.duplicateRegistrations.length, 3);
  assert.ok(report.structuralErrors.some((s) => s.includes('standards: 重复角色 a')));
  assert.ok(report.structuralErrors.some((s) => s.includes('view: 重复形态 a/o')));
});

test('CLI rejects count mismatch, same-shard empty duplicate characters and malformed roots independently', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-coverage-'));
  try {
    const mutate = (file: any, fn: any) => {
      const target = path.join(dir, file);
      writeJson(target, fn(JSON.parse(fs.readFileSync(target, 'utf8'))));
    };
    const cases = [
      () => mutate('data/popular/manifest.json', (v: any) => { v.files[0].count = 99; return v; }),
      () => {
        mutate('data/popular/a.json', (v: any) => { v.characters.push({ id: 'char_x', outfits: [] }); return v; });
        mutate('data/popular/manifest.json', (v: any) => { v.files[0].count++; return v; });
      },
      () => mutate('data/character-reference-standards.json', () => ({})),
      () => mutate('data/character-reference-view.json', () => ([])),
      () => mutate('data/popular/manifest.json', (v: any) => { v.files[0].file = '../outside.json'; return v; }),
    ];
    for (const change of cases) {
      makeBaseFixture(dir);
      change();
      const result = spawnSync(process.execPath, [REPORT, '--json', '--root', dir], { encoding: 'utf8', windowsHide: true });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /结构错误/);
      assert.doesNotMatch(result.stderr, /TypeError|at main/);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('--root ignores ambient resource roots and never executes fixture config', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-coverage-'));
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-external-'));
  try {
    makeBaseFixture(dir);
    fs.mkdirSync(path.join(dir, 'server'));
    fs.writeFileSync(path.join(dir, 'server/config.js'), 'throw new Error("fixture config executed");');
    fs.mkdirSync(path.join(dir, 'assets/character-references/char_x/o1'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'assets/character-references/char_x/o1/ref_a.png'), 'fixture');
    const result = spawnSync(process.execPath, [REPORT, '--json', '--root', dir], {
      encoding: 'utf8', windowsHide: true,
      env: { ...process.env, AICS_ASSETS_ROOT: external, AICS_CHARACTER_REF_ROOT: external, AICS_REFERENCE_AUDIT_MODE: 'structure' },
    });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.reference.verifiedImage, 1);
    assert.equal(report.reference.missingImage.length, 1);
    assert.deepEqual(fs.readdirSync(external), []);
    assert.equal(fs.existsSync(path.join(dir, 'data/popular-characters.json')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(external, { recursive: true, force: true });
  }
});

// ---- G9：--character/--outfit 局部筛选 ----

/** 筛选夹具：标准夹具追加 char_z（z1/z2 均已登记；z1 实图在位、z2 URL 缺文件），
 *  并落盘 char_x/o1 实图。char_z 故意不进 characters.json，验证身份全集含热门分片。 */
function makeScopedFixture(dir: any) {
  makeBaseFixture(dir);
  const mutate = (file: any, fn: any) => {
    const target = path.join(dir, file);
    writeJson(target, fn(JSON.parse(fs.readFileSync(target, 'utf8'))));
  };
  mutate('data/popular/a.json', (v: any) => { v.characters.push({ id: 'char_z', displayName: 'Z', aliases: [], outfits: [{ id: 'z1' }, { id: 'z2' }] }); return v; });
  mutate('data/popular/manifest.json', (v: any) => { v.files[0].count = 3; return v; });
  mutate('data/character-reference-standards.json', (v: any) => { v.characters.push({ id: 'char_z', outfits: [{ id: 'z1' }, { id: 'z2' }] }); return v; });
  mutate('data/character-reference-view.json', (v: any) => {
    v.char_z = { outfits: [
      { outfitId: 'z1', references: [{ id: 'ref_z1', url: '/character-references/char_z/z1/ref_z1.png', pending: false }] },
      { outfitId: 'z2', references: [{ id: 'ref_z2', url: '/character-references/char_z/z2/ref_z2.png', pending: false }] },
    ] };
    return v;
  });
  for (const [rel, content] of [
    ['assets/character-references/char_x/o1/ref_a.png', 'fixture-x'],
    ['assets/character-references/char_z/z1/ref_z1.png', 'fixture-z'],
  ]) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

function snapshotTree(dir: any) {
  const entries: any = [];
  const walk = (current: any, prefix: any) => {
    for (const item of fs.readdirSync(current, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.isDirectory()) walk(path.join(current, item.name), rel);
      else entries.push(`${rel}:${fs.readFileSync(path.join(current, item.name)).toString('base64')}`);
    }
  };
  walk(dir, '');
  return entries.sort();
}

test('parseSelectionArgs enforces outfit-with-character and value presence', () => {
  assert.equal(parseSelectionArgs([]), null);
  assert.equal(parseSelectionArgs(['--json']), null);
  assert.deepEqual(parseSelectionArgs(['--character', 'char_x']), { character: 'char_x', outfit: null });
  assert.deepEqual(parseSelectionArgs(['--character', 'char_x', '--outfit', 'o1']), { character: 'char_x', outfit: 'o1' });
  assert.throws(() => parseSelectionArgs(['--outfit', 'o1']), /--outfit 必须与 --character 同时使用/);
  assert.throws(() => parseSelectionArgs(['--character']), /--character 需要一个 ID 值/);
  assert.throws(() => parseSelectionArgs(['--character', '']), /--character 需要一个 ID 值/);
  assert.throws(() => parseSelectionArgs(['--character', '--json']), /--character 需要一个 ID 值/);
  assert.throws(() => parseSelectionArgs(['--character', '  ']), /需要一个 ID 值/);
  assert.throws(() => parseSelectionArgs(['--character', 'a', '--character', 'b']), /不能重复指定/);
  assert.throws(() => parseSelectionArgs(['--character', 'a', '--outfit', 'one', '--outfit', 'two']), /不能重复指定/);
  assert.throws(() => parseSelectionArgs(['--character=a']), /筛选参数需使用/);
});

test('scoped pure pipeline: recording fileExists proves unselected references are never checked', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-coverage-'));
  try {
    makeScopedFixture(dir);
    const data = loadFixtureData(dir);
    const scopedUrls = collectScopedRefUrls({ view: data.view, character: 'char_z', outfit: null });
    assert.deepEqual([...scopedUrls].sort(), [
      '/character-references/char_z/z1/ref_z1.png',
      '/character-references/char_z/z2/ref_z2.png',
    ]);
    const calls: any = [];
    const report = buildReport({
      characters: data.characters,
      popularRows: data.rows,
      standards: data.standards,
      view: data.view,
      selectors: [],
      popularAliasMap: popularAliasMapOf(data.sources.flatMap(({ characters }: any) => characters)),
      fileExists: scopeFileExists((url: any) => { calls.push(url); return true; }, scopedUrls),
    });
    // char_x 的 o1/o2 URL 已登记且非 pending，全库模式会核对；筛选 char_z 后不得触碰。
    assert.deepEqual(calls.sort(), [
      '/character-references/char_z/z1/ref_z1.png',
      '/character-references/char_z/z2/ref_z2.png',
    ]);
    const scoped = filterReportToScope(report, { character: 'char_z', outfit: null });
    assert.equal(scoped.reference.verifiedImage, 2);
    assert.deepEqual(scoped.reference.missingImage, []);
    // 无关角色不出现在局部条目中。
    for (const key of ['missingRegistration', 'pending', 'missingImage', 'unverifiedImage', 'referenceOnlyForms']) {
      assert.ok((scoped.reference as Record<string, any>)[key].every((row: any) => row.id === 'char_z'), `${key} 混入无关角色`);
    }
    // 结构字段保留全库结果，scope 元数据可机读。
    assert.deepEqual(scoped.structuralErrors, report.structuralErrors);
    assert.deepEqual(scoped.reference.mirrorErrors, report.reference.mirrorErrors);
    assert.deepEqual(scoped.scope, {
      mode: 'character', character: 'char_z', outfit: null,
      coverageCountsScope: 'selected', structuralChecksScope: 'all', unselectedReferenceFilesChecked: false,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI --character lists only that character with recomputed counts and scope metadata', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-coverage-'));
  try {
    makeScopedFixture(dir);
    const result = spawnSync(process.execPath, [REPORT, '--json', '--root', dir, '--character', 'char_x'],
      { encoding: 'utf8', timeout: 20000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.version, 1);
    assert.equal(report.scope.character, 'char_x');
    assert.equal(report.scope.outfit, null);
    assert.deepEqual(report.reference.missingRegistration.map((row: any) => `${row.id}/${row.outfitId}`), ['char_x/o9']);
    assert.deepEqual(report.reference.pending.map((row: any) => row.outfitId), ['o3']);
    assert.deepEqual(report.reference.missingImage.map((row: any) => row.outfitId), ['o2']);
    assert.equal(report.reference.verifiedImage, 1);
    assert.deepEqual(report.reference.referenceOnlyForms.map((row: any) => row.outfitId), ['ghost_form']);
    assert.deepEqual(report.themes.explicit, ['char_x']);
    assert.deepEqual(report.themes.missingTheme, []);
    assert.deepEqual(report.themes.defaultAllowed, []);
    // 无关角色与全库主题信息不进入局部条目。
    const serialized = result.stdout;
    assert.ok(!serialized.includes('char_y'), 'char_y 不应出现在 char_x 局部条目');
    assert.ok(!serialized.includes('char_k'), 'char_k 不应出现在 char_x 局部条目');
    assert.deepEqual(report.themes.staleAlias, []);
    assert.deepEqual(report.themes.nonCharacter, []);
    assert.equal(report.scope.unselectedReferenceFilesChecked, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI --outfit narrows to one outfit including missing-registration, pending and reference-only forms', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-coverage-'));
  try {
    makeScopedFixture(dir);
    const run = (outfit: any) => JSON.parse(spawnSync(process.execPath,
      [REPORT, '--json', '--root', dir, '--character', 'char_x', '--outfit', outfit],
      { encoding: 'utf8', timeout: 20000, windowsHide: true }).stdout);
    const missing = run('o9');
    assert.equal(missing.scope.mode, 'character-outfit');
    assert.equal(missing.scope.outfit, 'o9');
    assert.deepEqual(missing.reference.missingRegistration.map((row: any) => row.outfitId), ['o9']);
    assert.equal(missing.reference.pending.length, 0);
    assert.equal(missing.reference.verifiedImage, 0);
    const pending = run('o3');
    assert.deepEqual(pending.reference.pending, [
      { id: 'char_x', outfitId: 'o3', source: 'data/character-reference-view.json', pending: 1, total: 1 },
    ]);
    assert.equal(pending.reference.verifiedImage, 0);
    const ghost = run('ghost_form');
    assert.deepEqual(ghost.reference.referenceOnlyForms.map((row: any) => row.outfitId), ['ghost_form']);
    assert.equal(ghost.reference.missingRegistration.length, 0);
    const o1 = run('o1');
    assert.equal(o1.reference.verifiedImage, 1);
    assert.equal(o1.reference.missingImage.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scoped run with absent reference root reports unverified, never verified', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-coverage-'));
  try {
    makeScopedFixture(dir);
    fs.rmSync(path.join(dir, 'assets'), { recursive: true, force: true });
    const result = spawnSync(process.execPath, [REPORT, '--json', '--root', dir, '--character', 'char_x'],
      { encoding: 'utf8', timeout: 20000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.reference.unverifiedImage.map((row: any) => row.outfitId).sort(), ['o1', 'o2']);
    assert.equal(report.reference.verifiedImage, 0);
    assert.equal(report.reference.missingImage.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('full-library structural errors stay visible and fail the scoped run', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-coverage-'));
  try {
    makeScopedFixture(dir);
    // 无关角色 nene 的镜像破坏：不应因筛选 char_x 而被掩盖。
    const standards = JSON.parse(fs.readFileSync(path.join(dir, 'data/character-reference-standards.json'), 'utf8'));
    standards.characters.find((c: any) => c.id === 'nene').outfits.push({ id: 'mirror_drift' });
    fs.writeFileSync(path.join(dir, 'data/character-reference-standards.json'), JSON.stringify(standards));
    const result = spawnSync(process.execPath, [REPORT, '--json', '--root', dir, '--character', 'char_x'],
      { encoding: 'utf8', timeout: 20000, windowsHide: true });
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.ok(report.structuralErrors.some((m: any) => m.includes('镜像破坏') && m.includes('nene') && m.includes('mirror_drift')),
      '全域镜像错误应保留');
    assert.ok(report.scope.structuralChecksScope === 'all');
    // 局部条目照常列出，不被结构错误吞掉。
    assert.deepEqual(report.reference.missingRegistration.map((row: any) => `${row.id}/${row.outfitId}`), ['char_x/o9']);
    // 人类输出注明全域错误不一定由所选对象造成。
    const human = spawnSync(process.execPath, [REPORT, '--root', dir, '--character', 'char_x'],
      { encoding: 'utf8', timeout: 20000, windowsHide: true });
    assert.equal(human.status, 1);
    assert.ok(human.stderr.includes('不一定由所选对象造成'), human.stderr);
    assert.ok(human.stdout.includes('筛选范围：char_x'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('unknown ids and malformed selection fail as parameter errors without a report', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-coverage-'));
  try {
    makeScopedFixture(dir);
    const run = (...args) => spawnSync(process.execPath, [REPORT, '--json', '--root', dir, ...args],
      { encoding: 'utf8', timeout: 20000, windowsHide: true });
    const unknownChar = run('--character', 'nope');
    assert.equal(unknownChar.status, 2);
    assert.equal(unknownChar.stdout.trim(), '', '未知角色不得产出报告');
    assert.match(unknownChar.stderr, /参数错误/);
    assert.match(unknownChar.stderr, /未知角色 ID "nope"/);
    const unknownOutfit = run('--character', 'char_x', '--outfit', 'nope');
    assert.equal(unknownOutfit.status, 2);
    assert.match(unknownOutfit.stderr, /角色 char_x 无服装 ID "nope"/);
    const outfitAlone = run('--outfit', 'o1');
    assert.equal(outfitAlone.status, 2);
    assert.match(outfitAlone.stderr, /--outfit 必须与 --character 同时使用/);
    const missingValue = run('--character');
    assert.equal(missingValue.status, 2);
    assert.match(missingValue.stderr, /需要一个 ID 值/);
    // 旧别名/旧选择器不是规范 ID：报错并给出建议，不自动解析。
    const alias = run('--character', 'historia_reiss');
    assert.equal(alias.status, 2);
    assert.match(alias.stderr, /不是规范 ID/);
    assert.match(alias.stderr, /char_k/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scoped CLI runs are read-only: fixture tree unchanged and unfiltered output keeps no scope key', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-coverage-'));
  try {
    makeScopedFixture(dir);
    const before = snapshotTree(dir);
    const scoped = spawnSync(process.execPath, [REPORT, '--json', '--root', dir, '--character', 'char_x', '--outfit', 'o1'],
      { encoding: 'utf8', timeout: 20000, windowsHide: true });
    const human = spawnSync(process.execPath, [REPORT, '--root', dir, '--character', 'char_x'],
      { encoding: 'utf8', timeout: 20000, windowsHide: true });
    assert.equal(scoped.status, 0, scoped.stderr);
    assert.equal(human.status, 0, human.stderr);
    assert.deepEqual(snapshotTree(dir), before, '筛选运行不得写入或改动夹具');
    // 无参数旧行为：全库输出不携带 scope 字段。
    const full = spawnSync(process.execPath, [REPORT, '--json', '--root', dir],
      { encoding: 'utf8', timeout: 20000, windowsHide: true });
    assert.equal(full.status, 0, full.stderr);
    const parsed = JSON.parse(full.stdout);
    assert.equal('scope' in parsed, false);
    assert.deepEqual(parsed.reference.missingRegistration.map((row: any) => `${row.id}/${row.outfitId}`).sort(),
      ['char_k/k1', 'char_x/o9', 'char_y/o4'].sort());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('selection isolates owners even when unselected outfits and characters share the selected URL', () => {
  const url = '/character-references/shared.png';
  const popularRows = [
    { id: 'a', outfitId: 'one', file: 'a.json' },
    { id: 'a', outfitId: 'two', file: 'a.json' },
    { id: 'b', outfitId: 'one', file: 'b.json' },
  ];
  const view = ['a', 'b'].map(id => ({ id, outfits: (id === 'a' ? ['one', 'two'] : ['one']).map(outfitId => ({
    outfitId, references: [{ id: 'r', url }],
  })) }));
  const standards = view.map(row => ({ id: row.id, outfitIds: row.outfits.map(o => o.outfitId) }));
  for (const outfit of [null, 'one']) {
    const selection = { character: 'a', outfit };
    const calls = [];
    const report = buildReport({
      characters: [{ id: 'a' }, { id: 'b' }, { id: 'b' }], popularRows, standards, view,
      selectors: [], popularAliasMap: new Map(),
      fileExists: scopeFileExists((value: any) => { calls.push(value); return true; },
        collectScopedRefUrls({ view, ...selection }), selection),
    });
    const scoped = filterReportToScope(report, selection);
    assert.equal(calls.length, outfit ? 1 : 2, 'only selected owners may inspect a shared URL');
    assert.equal(scoped.reference.verifiedImage, calls.length);
    assert.deepEqual(scoped.themes.dupCharacters, ['b'], 'all-domain structural details stay visible');
    assert.ok(scoped.structuralErrors.some((message: any) => message.includes('重复角色 ID: b')));
  }
});

test('CLI accepts canonical popular-only character with no outfits', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-coverage-'));
  try {
    makeBaseFixture(dir);
    const shardPath = path.join(dir, 'data/popular/a.json');
    const shard = JSON.parse(fs.readFileSync(shardPath, 'utf8'));
    shard.characters.push({ id: 'empty_character', outfits: [] });
    writeJson(shardPath, shard);
    const manifestPath = path.join(dir, 'data/popular/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.files[0].count++;
    writeJson(manifestPath, manifest);
    const result = spawnSync(process.execPath, [REPORT, '--json', '--root', dir, '--character', 'empty_character'],
      { encoding: 'utf8', timeout: 20000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.scope.character, 'empty_character');
    assert.equal(report.reference.verifiedImage, 0);
    assert.deepEqual(report.reference.missingRegistration, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
