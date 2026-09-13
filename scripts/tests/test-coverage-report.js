'use strict';

/**
 * test-coverage-report.js — audit:coverage 差额报告的隔离夹具测试。
 *
 * 覆盖主任务交接要求的验收点：双方 ID 集合差额、缺文件、重复 ID、缺批号
 * （manifest 批次数不符）、结果可复跑；全部使用临时夹具，不触碰生产 data/。
 * 运行：node --test scripts/tests/test-coverage-report.js
 */

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const REPORT = path.join(ROOT, 'scripts', 'maintenance', 'report-content-coverage.js');
const {
  analyseThemes, analyseReferences, extractThemeSelectors, normalizeAlias,
  popularAliasMapOf, buildReport, makeFileExists, DEFAULT_THEME_ALLOWED,
} = require('../maintenance/report-content-coverage');

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

/** 标准夹具：char_x(o1 已登记有图/o2 已登记缺图/o3 pending/o9 未登记)、
 *  char_y(o4 未登记)、char_k(旧别名宿主)、nene(默认主题)。 */
function makeBaseFixture(dir) {
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

function loadFixtureData(dir) {
  const readJson = (file) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  const manifest = readJson('data/popular/manifest.json');
  const sources = manifest.files.map((entry) => ({
    entry,
    characters: readJson(path.join('data/popular', entry.file)).characters,
  }));
  const rows = sources.flatMap(({ entry, characters }) =>
    characters.flatMap((character) => (character.outfits || []).map((outfit) => ({ id: character.id, outfitId: outfit.id, file: entry.file }))));
  const standards = readJson('data/character-reference-standards.json').characters
    .map((c) => ({ id: c.id, outfitIds: c.outfits.map((o) => o.id) }));
  const view = Object.entries(readJson('data/character-reference-view.json')).map(([id, profile]) => ({
    id,
    outfits: profile.outfits.map((o) => ({ outfitId: o.outfitId, references: o.references })),
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
  const exists = (url) => (url.includes('shot') ? true : url.includes('gone') ? false : null);
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
      popularAliasMap: popularAliasMapOf(data.sources.flatMap(({ characters }) => characters)),
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
    assert.deepEqual(parsed.reference.missingRegistration.map((row) => `${row.id}/${row.outfitId}`).sort(),
      ['char_k/k1', 'char_x/o9', 'char_y/o4'].sort());
    const pendingRow = parsed.reference.pending.find((row) => row.id === 'char_x' && row.outfitId === 'o3');
    assert.equal(pendingRow.pending, 1);
    const stale = parsed.themes.staleAlias.find((row) => row.selector === 'historia_reiss');
    assert.equal(stale.suggestion, 'char_k');
    assert.deepEqual(parsed.themes.missingTheme.map((row) => row.id).sort(), ['char_y']);
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
    fileExists: (url) => url.includes('ok') ? true : url.includes('missing') ? false : null,
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
    const mutate = (file, fn) => {
      const target = path.join(dir, file);
      writeJson(target, fn(JSON.parse(fs.readFileSync(target, 'utf8'))));
    };
    const cases = [
      () => mutate('data/popular/manifest.json', (v) => { v.files[0].count = 99; return v; }),
      () => {
        mutate('data/popular/a.json', (v) => { v.characters.push({ id: 'char_x', outfits: [] }); return v; });
        mutate('data/popular/manifest.json', (v) => { v.files[0].count++; return v; });
      },
      () => mutate('data/character-reference-standards.json', () => ({})),
      () => mutate('data/character-reference-view.json', () => ([])),
      () => mutate('data/popular/manifest.json', (v) => { v.files[0].file = '../outside.json'; return v; }),
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
