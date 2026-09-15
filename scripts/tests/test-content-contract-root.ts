'use strict';

/**
 * scripts/tests/test-content-contract-root.js — G11 内容契约校验统一隔离根测试
 *
 * 全部数据读写限定在 os.tmpdir() 自建夹具；被测 CLI 以子进程 spawn，通过
 * AICS_DATA_ROOT / AICS_APP_ROOT 指向完整项目布局根（data/assets/src/stores）。
 * 零写入由夹具全量快照证明；另在 CLI 预加载 fs 探针，拒绝读取仓库数据域及写入。
 * 夹具 DATA_VERSION 由夹具数据哈希计算，成功行同时核对夹具特有数量。
 * 参考核对使用夹具素材或 structure 模式，不访问真实素材；不做 Git 写操作，
 * 不构建共享 dist。运行：node scripts/tests/test-content-contract-root.js
 */

const { test }: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs: typeof import('node:fs') = require('node:fs');
const os: typeof import('node:os') = require('node:os');
const path: typeof import('node:path') = require('node:path');
const zlib: typeof import('node:zlib') = require('node:zlib');
const { spawnSync }: typeof import('node:child_process') = require('node:child_process');

const { REPO_ROOT, resolveContentRoot }: typeof import('../lib/content-contract-root') = require('../lib/content-contract-root');
const { expectedDataVersion }: typeof import('../lib/data-version') = require('../lib/data-version');

const CLI = path.join(REPO_ROOT, 'scripts', 'maintenance', 'validate-content-contracts.js');

/** 夹具外的根相关环境变量全部剥离，避免宿主环境污染优先级结论。 */
const STRIPPED_ENV_KEYS = [
  'AICS_DATA_ROOT', 'AICS_APP_ROOT', 'AICS_ASSETS_ROOT',
  'AICS_CHARACTER_REF_ROOT', 'AICS_REFERENCE_AUDIT_MODE', 'AI_WORKSPACE_ROOT',
];

function baseEnv() {
  const env = { ...process.env };
  for (const key of STRIPPED_ENV_KEYS) delete env[key];
  return env;
}

function runCli(overrides: any) {
  return spawnSync(process.execPath, [CLI], { encoding: 'utf8', env: Object.assign(baseEnv(), overrides) });
}

test('隔离 CLI 的 fs 调用不读取仓库数据域且不执行写入', (t) => {
  const fixture = buildValidFixture(t, { characterCount: 1 });
  const root = fixture.root;
  const preload = path.join(root, 'guard.cjs');
  fs.writeFileSync(preload, `
    const fs = require('node:fs');
    const path = require('node:path');
    const protectedRoots = ${JSON.stringify(['data', 'assets', 'src/stores'].map(p => path.join(REPO_ROOT, p)))};
    const violations = [];
    const inside = (p, root) => {
      const rel = path.relative(root, path.resolve(String(p)));
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    };
    for (const name of ['readFileSync', 'openSync', 'statSync', 'lstatSync', 'existsSync', 'readdirSync', 'realpathSync']) {
      const original = fs[name];
      fs[name] = function(p, ...args) {
        if (typeof p === 'string' && protectedRoots.some(root => inside(p, root))) {
          violations.push(name + ':' + p);
          throw new Error('unexpected production access: ' + p);
        }
        return original.call(this, p, ...args);
      };
    }
    for (const name of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'renameSync', 'unlinkSync', 'rmSync', 'copyFileSync']) {
      fs[name] = function() { violations.push(name); throw new Error('unexpected write: ' + name); };
    }
    process.on('exit', () => {
      if (violations.length) { console.error(violations.join('\\n')); process.exitCode = 99; }
    });
  `);
  const before = snapshot(root);
  const result = spawnSync(process.execPath, ['--require', preload, CLI], {
    encoding: 'utf8', env: { ...baseEnv(), AICS_DATA_ROOT: root },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Content contracts passed/);
  assert.deepEqual(snapshot(root), before);
});

function writeJson(file: any, value: any) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

function snapshot(root: any) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(root, entry.name);
    if (entry.isSymbolicLink()) return [[full, '<link>']];
    return entry.isDirectory() ? snapshot(full) : [[full, fs.readFileSync(full).toString('base64')]];
  });
}

// ── 夹具：完整项目布局根 ────────────────────────────────────────────────────

const POPULAR_CHARACTER = {
  id: 'fixture_pop',
  displayName: 'Fixture Pop',
  originalName: 'Fixture Pop',
  franchise: 'Fixture Franchise',
  aliases: ['Fixture Alias'],
  identityProse: 'A friendly fixture character with silver hair and amber eyes.',
  identityTokens: ['silver_hair', 'amber_eyes'],
  exactTokens: [],
  exactPrefixes: [],
  recommendedEngine: 'anima',
  supportedEngines: ['anima', 'krea'],
  adultEligibility: 'unknown',
  outfits: [{
    id: 'casual',
    name: 'Casual',
    prose: 'wearing a plain beige sweater and a long pleated skirt.',
    tokens: ['beige_sweater', 'pleated_skirt'],
    default: true,
  }],
};

function fixtureBlueprint(index: any, adult: any) {
  return {
    id: 'bp-fixture-' + String(index).padStart(2, '0'),
    title: 'Fixture blueprint ' + index,
    category: 'daily',
    description: 'Fixture blueprint description ' + index + '.',
    characterId: 'fixture_pop',
    location: 'fixture terrace',
    action: 'waving at the viewer',
    timeOfDay: 'afternoon',
    lighting: 'soft diffused light',
    camera: 'medium shot',
    mood: 'cheerful',
    sceneTags: ['fixture'],
    promptProse: 'A fixture scene rendered with soft light.',
    promptTokens: ['fixture_scene', 'soft_light'],
    negativeTokens: 'lowres, bad anatomy',
    recommendedSize: '832x1216',
    adult: Boolean(adult),
  };
}

const BLUEPRINTS = Array.from({ length: 21 }, (_, i) => fixtureBlueprint(i + 1, i === 20));

/**
 * 构建可通过全部契约检查的完整布局根。sceneCount = characterCount + 1
 * （每个角色一景 + 一景 triad），两套参数产生可区分的成功行与 DATA_VERSION。
 */
function buildValidFixture(t: any, options: any) {
  const characterIds = Array.from({ length: options.characterCount }, (_, i) => (i === 0 ? 'hana' : 'hana' + (i + 1)));
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'content-contract-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'app-root');
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(root, 'assets', 'characters'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'stores'), { recursive: true });

  const characters = characterIds.map((id) => ({
    id,
    name: 'Fixture ' + id,
    source: 'Fixture Source',
    speech: 'calm',
    type: 'heroine',
    portrait: { image: '../assets/characters/' + id + '-portrait.webp', alt: id + ' portrait' },
    visual_dna: { signature: id + ' signature: silver hair and amber eyes' },
    traits: ['gentle', 'fixture', 'steady'],
    lora: { name: 'fixture_lora', weight: 0.8 },
  }));
  characterIds.forEach((id) => {
    fs.writeFileSync(path.join(root, 'assets', 'characters', id + '-portrait.webp'), id + ' portrait bytes');
  });

  const loras = [{
    id: 'lora-fixture',
    name: 'fixture_lora',
    strength: { min: 0.4, default: 0.8, max: 1.2 },
    compatible_models: ['anima'],
    test_scene: ['s-fixture-1'],
  }];

  const scenes = characterIds.map((id, i) => ({
    id: 's-fixture-' + (i + 1),
    title: 'Fixture scene ' + (i + 1),
    char: id,
    character: [id],
    prompt: 'fixture prompt ' + (i + 1),
  }));
  scenes.push({
    id: 's-fixture-' + (characterIds.length + 1),
    title: 'Fixture triad scene',
    char: 'triad',
    character: characterIds,
    prompt: 'fixture triad prompt',
  });

  const shard = (char: any) => scenes.filter((scene) => scene.char === char);
  writeJson(path.join(dataDir, 'characters.json'), characters);
  writeJson(path.join(dataDir, 'loras.json'), loras);
  writeJson(path.join(dataDir, 'scenes.json'), scenes);
  writeJson(path.join(dataDir, 'scenes-nene.json'), scenes.filter((s) => s.char !== 'triad' && s.char !== 'natsume'));
  writeJson(path.join(dataDir, 'scenes-natsume.json'), shard('natsume'));
  writeJson(path.join(dataDir, 'scenes-shared.json'), shard('triad'));
  writeJson(path.join(dataDir, 'scenes-core.json'), [scenes[0]]);
  writeJson(path.join(dataDir, 'scenes-index.json'), {
    total: scenes.length,
    tiers: { core: [scenes[0].id] },
    orderedIds: scenes.map((scene) => scene.id),
  });
  writeJson(path.join(dataDir, 'curation.json'), { tiers: {} });
  writeJson(path.join(dataDir, 'tags.json'), {});
  writeJson(path.join(dataDir, 'presets.json'), {});
  writeJson(path.join(dataDir, 'popular-characters.json'), { characters: [POPULAR_CHARACTER] });
  writeJson(path.join(dataDir, 'scene-blueprints.json'), { blueprints: BLUEPRINTS });
  writeJson(path.join(dataDir, 'character-reference-view.json'), {
    [characterIds[0]]: { outfits: [{ outfitId: 'default', references: [{ url: '/assets/characters/' + characterIds[0] + '-portrait.webp' }] }] },
  });

  const dataVersion = expectedDataVersion(root);
  fs.writeFileSync(path.join(root, 'src', 'stores', 'sceneStore.ts'),
    '// fixture layout root store\nexport const DATA_VERSION = ' + dataVersion + ';\n');

  return { base, root, characterIds, dataVersion };
}

/** 只有目录、没有任何布局文件的坏根：用于证明选错根按缺失报错而非假通过。 */
function buildEmptyLayoutRoot(t: any) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'content-contract-empty-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'app-root');
  fs.mkdirSync(root, { recursive: true });
  return { base, root };
}

// ── 根解析优先级（纯函数） ──────────────────────────────────────────────────

test('resolveContentRoot 遵循 AICS_DATA_ROOT > AICS_APP_ROOT > 仓库根', () => {
  assert.equal(REPO_ROOT, path.resolve(__dirname, '..', '..'));
  assert.equal(resolveContentRoot(), REPO_ROOT);
  assert.equal(resolveContentRoot({}), REPO_ROOT);
  assert.equal(resolveContentRoot({ AICS_DATA_ROOT: 'rel-data' }), path.resolve('rel-data'));
  assert.equal(resolveContentRoot({ AICS_DATA_ROOT: 'a', AICS_APP_ROOT: 'b' }), path.resolve('a'));
  assert.equal(resolveContentRoot({ AICS_DATA_ROOT: '', AICS_APP_ROOT: 'b' }), path.resolve('b'), '空串视为未设置');
  assert.equal(resolveContentRoot({ AICS_APP_ROOT: 'b' }), path.resolve('b'));
});

// ── CLI：有效夹具与两种环境变量 ─────────────────────────────────────────────

test('完整有效夹具经 AICS_DATA_ROOT 校验通过，全程零写入且内容绑定夹具', (t) => {
  const fx = buildValidFixture(t, { characterCount: 1 });
  const before = snapshot(fx.root);
  const run = runCli({ AICS_DATA_ROOT: fx.root });
  assert.equal(run.status, 0, run.stderr);
  // 成功行是夹具特有数量：读生产或读另一根都会变成不同数字或失败。
  assert.equal(run.stdout.trim(), 'Content contracts passed: 1 characters, 1 LoRAs, 2 scenes');
  assert.deepEqual(snapshot(fx.root), before, '校验全程不得写夹具');
});

test('AICS_APP_ROOT 单独生效，第二个不同根读出自己的内容', (t) => {
  const fx = buildValidFixture(t, { characterCount: 2 });
  const run = runCli({ AICS_APP_ROOT: fx.root });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), 'Content contracts passed: 2 characters, 1 LoRAs, 3 scenes');
});

// ── CLI：优先级与选错根不假通过 ─────────────────────────────────────────────

test('AICS_DATA_ROOT 优先于 AICS_APP_ROOT，选错根按缺失报错', (t) => {
  const good = buildValidFixture(t, { characterCount: 1 });
  const broken = buildEmptyLayoutRoot(t);

  const dataWins = runCli({ AICS_DATA_ROOT: good.root, AICS_APP_ROOT: broken.root });
  assert.equal(dataWins.status, 0, dataWins.stderr);
  assert.equal(dataWins.stdout.trim(), 'Content contracts passed: 1 characters, 1 LoRAs, 2 scenes');

  const dataBroken = runCli({ AICS_DATA_ROOT: broken.root, AICS_APP_ROOT: good.root });
  assert.equal(dataBroken.status, 1);
  assert.ok(dataBroken.stderr.includes('data/characters.json is missing or unreadable'), dataBroken.stderr);
  assert.ok(!dataBroken.stdout.includes('Content contracts passed'), '坏根不得借另一根或生产数据假通过');
});

test('根指向不存在路径时按缺失报错，不回退读取生产数据', () => {
  const absent = path.join(os.tmpdir(), 'content-contract-absent', 'never-created-root');
  const run = runCli({ AICS_DATA_ROOT: absent });
  assert.equal(run.status, 1);
  assert.ok(run.stderr.includes('data/characters.json is missing or unreadable'), run.stderr);
  assert.ok(!run.stdout.includes('Content contracts passed'));
});

// ── CLI：引用 / 压缩产物 / 版本三类失败各自定位 ─────────────────────────────

test('夹具引用失败定位报错；参考核对可用夹具素材或 structure 模式', (t) => {
  const noPortrait = buildValidFixture(t, { characterCount: 1 });
  fs.unlinkSync(path.join(noPortrait.root, 'assets', 'characters', 'hana-portrait.webp'));
  const portraitRun = runCli({ AICS_DATA_ROOT: noPortrait.root });
  assert.equal(portraitRun.status, 1);
  assert.ok(portraitRun.stderr.includes('characters[0].portrait.image does not exist'), portraitRun.stderr);
  assert.ok(portraitRun.stderr.includes('hana-portrait.webp'));

  const brokenView = buildValidFixture(t, { characterCount: 1 });
  writeJson(path.join(brokenView.root, 'data', 'character-reference-view.json'), {
    hana: { outfits: [{ outfitId: 'default', references: [{ url: '/assets/characters/hana-missing.webp' }] }] },
  });
  const viewRun = runCli({ AICS_DATA_ROOT: brokenView.root });
  assert.equal(viewRun.status, 1);
  assert.ok(viewRun.stderr.includes('character-reference-view: hana/default: /assets/characters/hana-missing.webp'), viewRun.stderr);

  // structure 模式 + 显式失效的参考根：/character-references/ URL 不触磁盘即可通过。
  const structure = buildValidFixture(t, { characterCount: 1 });
  writeJson(path.join(structure.root, 'data', 'character-reference-view.json'), {
    hana: { outfits: [{ outfitId: 'default', references: [{ url: '/character-references/hana/default/ref_01.png' }] }] },
  });
  const structureEnv = { AICS_DATA_ROOT: structure.root, AICS_CHARACTER_REF_ROOT: path.join(structure.base, 'no-such-ref-root') };
  const structureRun = runCli({ ...structureEnv, AICS_REFERENCE_AUDIT_MODE: 'structure' });
  assert.equal(structureRun.status, 0, structureRun.stderr);
  const withoutStructure = runCli(structureEnv);
  assert.equal(withoutStructure.status, 1, '同一夹具关闭 structure 模式必须按缺图报红');
  assert.ok(withoutStructure.stderr.includes('参考图缺失'), withoutStructure.stderr);
});

test('压缩产物过期、孤儿产物与坏产物分别定位报错', (t) => {
  const fx = buildValidFixture(t, { characterCount: 1 });
  const dataDir = path.join(fx.root, 'data');
  fs.writeFileSync(path.join(dataDir, 'scenes.json.gz'), zlib.gzipSync(Buffer.from('drifted content, not the source')));
  fs.writeFileSync(path.join(dataDir, 'orphan.json.gz'), zlib.gzipSync(Buffer.from('orphan payload')));
  fs.writeFileSync(path.join(dataDir, 'tags.json.br'), Buffer.from([0x21, 0x00, 0x00]));
  const before = snapshot(fx.root);
  const run = runCli({ AICS_DATA_ROOT: fx.root });
  assert.equal(run.status, 1);
  assert.ok(run.stderr.includes('scenes.json.gz 与源文件内容不一致'), run.stderr);
  assert.ok(run.stderr.includes('orphan precompressed artifact: data'), run.stderr);
  assert.ok(run.stderr.includes('orphan.json.gz cannot be decompressed') || run.stderr.includes('tags.json.br cannot be decompressed'), run.stderr);
  assert.deepEqual(snapshot(fx.root), before, '失败路径同样零写入');
});

test('DATA_VERSION 与夹具数据不一致会失败并指向两侧数值', (t) => {
  const fx = buildValidFixture(t, { characterCount: 1 });
  const storeFile = path.join(fx.root, 'src', 'stores', 'sceneStore.ts');
  assert.match(fs.readFileSync(storeFile, 'utf8'), new RegExp('DATA_VERSION = ' + fx.dataVersion));

  fs.writeFileSync(storeFile, '// fixture store\nexport const DATA_VERSION = ' + (fx.dataVersion + 1) + ';\n');
  const storeRun = runCli({ AICS_DATA_ROOT: fx.root });
  assert.equal(storeRun.status, 1);
  assert.ok(storeRun.stderr.includes('DATA_VERSION mismatch: sceneStore.ts has ' + (fx.dataVersion + 1)
    + ', data content expects ' + fx.dataVersion), storeRun.stderr);

  // 数据内容变化而 store 未同步：期望版本随之改变，同样报红。
  writeJson(path.join(fx.root, 'data', 'curation.json'), { tiers: {}, drifted: true });
  const beforeDataRun = snapshot(fx.root);
  const dataRun = runCli({ AICS_DATA_ROOT: fx.root });
  assert.equal(dataRun.status, 1);
  assert.ok(dataRun.stderr.includes('DATA_VERSION mismatch: sceneStore.ts has ' + (fx.dataVersion + 1)), dataRun.stderr);
  assert.deepEqual(snapshot(fx.root), beforeDataRun, '失败路径同样零写入');
});

test('缺文件与坏 JSON 输出定位失败且退出非零', (t) => {
  const missing = buildValidFixture(t, { characterCount: 1 });
  fs.rmSync(path.join(missing.root, 'data', 'loras.json'));
  const missingRun = runCli({ AICS_DATA_ROOT: missing.root });
  assert.equal(missingRun.status, 1);
  assert.ok(missingRun.stderr.includes('data/loras.json is missing or unreadable'), missingRun.stderr);
  assert.ok(missingRun.stderr.includes('DATA_VERSION 计算失败'), missingRun.stderr);

  const corrupt = buildValidFixture(t, { characterCount: 1 });
  fs.writeFileSync(path.join(corrupt.root, 'data', 'characters.json'), '{ not json');
  const corruptRun = runCli({ AICS_DATA_ROOT: corrupt.root });
  assert.equal(corruptRun.status, 1);
  assert.ok(corruptRun.stderr.includes('data/characters.json is missing or unreadable'), corruptRun.stderr);
  assert.ok(!corruptRun.stdout.includes('Content contracts passed'));
});

// ── 导出兼容与注册入口 ──────────────────────────────────────────────────────

test('validateContent 导出保持无环境参数兼容，既有契约规则保留', () => {
  const { validateContent } = require(CLI);
  const good = {
    characters: [{
      id: 'hana', name: 'Hana', source: 'S', speech: 'calm',
      portrait: { image: 'x.webp' }, visual_dna: { signature: 'sig' },
      traits: ['a', 'b', 'c'], lora: { name: 'lora1', weight: 0.8 },
    }],
    loras: [{ id: 'l1', name: 'lora1', strength: { min: 0.5, default: 0.8, max: 1.0 }, compatible_models: ['anima'] }],
    scenes: [],
  };
  assert.deepEqual(validateContent(good, () => true), []);
  const broken = validateContent({ characters: [], loras: [], scenes: 5 }, () => true);
  assert.ok(broken.includes('characters.json must contain at least one character'));
  assert.ok(broken.includes('loras.json must contain at least one LoRA'));
  assert.ok(broken.includes('scenes.json must be an array'));
  assert.ok(broken.some((message: any) => message.includes('scenes.json must be an array')));
});

test('注册入口 check:content 转发统一根环境并在夹具上通过', (t) => {
  const fx = buildValidFixture(t, { characterCount: 1 });
  const run = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'workflow.js'), 'check:content'], {
    encoding: 'utf8',
    env: Object.assign(baseEnv(), { AICS_DATA_ROOT: fx.root }),
  });
  assert.equal(run.status, 0, (run.stdout || '') + (run.stderr || ''));
});
