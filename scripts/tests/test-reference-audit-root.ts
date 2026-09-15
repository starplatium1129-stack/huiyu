'use strict';

/**
 * scripts/tests/test-reference-audit-root.js — G14 参考 URL 校验 CLI 统一根与帮助边界测试
 *
 * 被测 CLI（scripts/maintenance/check-ref-urls.js）以子进程 spawn，全部数据读写限定在
 * os.tmpdir() 自建夹具；根相关宿主环境变量全部剥离，避免宿主环境污染优先级结论。
 * 预加载 fs 探针证明：指定夹具根时不读取生产 view/assets 与其他夹具根（不交叉读取）、
 * 全程零写入；--help/--plan 与参数错误对缺失根零访问。审计判定本身（pending/缺图/
 * unverified）由 test-character-reference-contract.js 覆盖，这里只回归 API 签名兼容。
 * 不做 Git 写操作，不构建共享 dist。运行：node scripts/tests/test-reference-audit-root.js
 */

const { test }: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs: typeof import('node:fs') = require('node:fs');
const os: typeof import('node:os') = require('node:os');
const path: typeof import('node:path') = require('node:path');
const crypto: typeof import('node:crypto') = require('node:crypto');
const { spawnSync }: typeof import('node:child_process') = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(REPO_ROOT, 'scripts', 'maintenance', 'check-ref-urls.js');

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

/** 每个用例一个临时父目录；夹具、探针都放里面，结束时整树删除。 */
function makeTempRoot(t: any) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-g14-'));
  t.after(() => {
    assert.ok(path.resolve(tempRoot).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
  return tempRoot;
}

function makeRoot(tempRoot: any, tag: any, { refs = [], files = [], viewBody } = {}) {
  const root = path.join(tempRoot, tag);
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  const view = viewBody === undefined
    ? { 'char-x': { characterId: 'char-x', outfits: [{ outfitId: 'default', references: refs }] } }
    : viewBody;
  fs.writeFileSync(path.join(root, 'data', 'character-reference-view.json'),
    typeof view === 'string' ? view : JSON.stringify(view));
  for (const rel of files) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), 'fixture-bytes:' + rel);
  }
  return root;
}

const urlRefs = (count: any) => Array.from({ length: count }, (_, i) =>
  ({ id: 'r' + (i + 1), url: '/character-references/r' + (i + 1) + '.png' }));
const refFiles = (count: any) => Array.from({ length: count }, (_, i) =>
  'assets/character-references/r' + (i + 1) + '.png');

/** 好夹具：count 条真实存在的 /character-references/ 引用；stdout 总数即指纹。 */
function makeGoodRoot(tempRoot: any, tag: any, count: any) {
  return makeRoot(tempRoot, tag, { refs: urlRefs(count), files: refFiles(count) });
}

function guardSource(protectedPaths: any) {
  return `
    const fs = require('node:fs');
    const path = require('node:path');
    const protectedRoots = ${JSON.stringify(protectedPaths)};
    const violations = [];
    const inside = (p, root) => {
      const rel = path.relative(root, path.resolve(String(p)));
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    };
    const hit = (p) => typeof p === 'string' && protectedRoots.some((root) => inside(p, root));
    for (const name of ['readFileSync', 'openSync', 'statSync', 'lstatSync', 'existsSync',
      'readdirSync', 'realpathSync', 'accessSync']) {
      const original = fs[name];
      fs[name] = function (p, ...args) {
        if (hit(p)) { violations.push(name + ':' + p); throw new Error('unexpected access: ' + p); }
        return original.call(this, p, ...args);
      };
    }
    for (const name of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'renameSync', 'unlinkSync',
      'rmSync', 'copyFileSync', 'chmodSync', 'mkdtempSync']) {
      fs[name] = function (...args) { violations.push(name); throw new Error('unexpected write: ' + name); };
    }
    process.on('exit', () => {
      if (violations.length) { console.error('PROBE VIOLATIONS:\\n' + violations.join('\\n')); process.exitCode = 99; }
    });
  `;
}

/** 带探针 spawn CLI：protectedPaths 内零访问，任何 fs 写入即违规（退出 99）。 */
function runProbed(tempRoot: any, args: any, envOverrides: any, protectedPaths: any) {
  const guard = path.join(tempRoot, 'guard.cjs');
  fs.writeFileSync(guard, guardSource(protectedPaths));
  return spawnSync(process.execPath, ['--require', guard, CLI, ...args], {
    encoding: 'utf8',
    env: Object.assign(baseEnv(), envOverrides),
  });
}

function snapshot(root: any) {
  const out: any = {};
  const walk = (rel: any) => {
    const abs = path.join(root, rel);
    if (fs.statSync(abs).isDirectory()) {
      out[rel + '/'] = 'dir';
      for (const entry of fs.readdirSync(abs).sort()) walk(path.join(rel, entry));
    } else {
      out[rel] = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex').slice(0, 16);
    }
  };
  for (const entry of fs.readdirSync(root).sort()) walk(entry);
  return out;
}

test('--help/--plan 退出 0，对缺失根与生产数据零访问', (t) => {
  const tempRoot = makeTempRoot(t);
  const missingA = path.join(tempRoot, 'no-such-data-root');
  const missingB = path.join(tempRoot, 'no-such-app-root');
  for (const flag of ['--help', '--plan']) {
    const result = runProbed(tempRoot, [flag],
      { AICS_DATA_ROOT: missingA, AICS_APP_ROOT: missingB },
      [missingA, missingB, path.join(REPO_ROOT, 'data'), path.join(REPO_ROOT, 'assets')]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /--root <完整项目根>/);
    assert.match(result.stdout, /优先级 --root > AICS_DATA_ROOT > AICS_APP_ROOT > 仓库根/);
    assert.match(result.stdout, /退出码：0 无断链/);
    assert.match(result.stdout, /2 参数或环境问题（未知\/重复\/缺值参数、根不可用）/);
    assert.ok(!result.stderr.includes('PROBE VIOLATIONS'), result.stderr);
  }
});

test('参数错误退出 2：未知/重复/缺值，且不读取任何根', (t) => {
  const tempRoot = makeTempRoot(t);
  const missingData = path.join(tempRoot, 'no-such-data-root');
  const probeList = [missingData, path.join(REPO_ROOT, 'data'), path.join(REPO_ROOT, 'assets')];
  const cases = [
    { args: ['--nope'], message: /无法识别的参数: --nope/ },
    { args: ['--root'], message: /参数缺值: --root/ },
    { args: ['--root', '--plan'], message: /参数缺值: --root/ },
    { args: ['--root', tempRoot, '--root', tempRoot], message: /重复参数: --root/ },
    { args: ['--help', '--help'], message: /重复参数: --help/ },
    { args: ['--root=' + tempRoot], message: /无法识别的参数: --root=/ },
  ];
  for (const { args, message } of cases) {
    const result = runProbed(tempRoot, args, { AICS_DATA_ROOT: missingData }, probeList);
    assert.equal(result.status, 2, `参数 ${JSON.stringify(args)} 应退出 2：${result.stdout} ${result.stderr}`);
    assert.match(result.stderr, message);
    assert.ok(!result.stderr.includes('PROBE VIOLATIONS'), result.stderr);
  }
});

test('无参数回退仓库根，输出与既有退出语义保持（真实数据只读）', (t) => {
  const tempRoot = makeTempRoot(t);
  const result = runProbed(tempRoot, [], {}, []);
  assert.ok(result.status === 0 || result.status === 1,
    `真实仓库门禁退出码应为 0/1，实际 ${result.status}：${result.stdout} ${result.stderr}`);
  assert.match(result.stdout, /^total urls: \d+ \| missing: \d+ \| pending: \d+ \| unverified: \d+ \| refRoot:/);
  assert.ok(!result.stderr.includes('错误:'), '根/参数错误不应出现在真实仓库运行中');
  assert.ok(!result.stderr.includes('PROBE VIOLATIONS'), result.stderr);
});

test('根优先级：--root > AICS_DATA_ROOT > AICS_APP_ROOT，数据根与素材根对齐', (t) => {
  const tempRoot = makeTempRoot(t);
  // rootA：2 条有效 + 1 条 pending，指纹唯一：total urls: 2 | missing: 0 | pending: 1
  const rootA = makeRoot(tempRoot, 'root-a', {
    refs: [...urlRefs(2), { id: 'p1', pending: true }],
    files: refFiles(2),
  });
  const rootB = makeGoodRoot(tempRoot, 'root-b', 5);
  const rootC = makeGoodRoot(tempRoot, 'root-c', 7);
  const repoData = path.join(REPO_ROOT, 'data');
  const repoAssets = path.join(REPO_ROOT, 'assets');

  // a) 数据根优先于应用根：读 A 的 view，且素材按 A 解析（对齐），完全不触碰 B。
  const a = runProbed(tempRoot, [],
    { AICS_DATA_ROOT: rootA, AICS_APP_ROOT: rootB }, [rootB, repoData, repoAssets]);
  assert.equal(a.status, 0, a.stdout + a.stderr);
  assert.match(a.stdout, /total urls: 2 \| missing: 0 \| pending: 1 \| unverified: 0/);
  assert.ok(!a.stderr.includes('PROBE VIOLATIONS'), '不应交叉读取 AICS_APP_ROOT：' + a.stderr);

  // b) 显式 --root 压过两套环境根：读 C，A/B 都不触碰。
  const b = runProbed(tempRoot, ['--root', rootC],
    { AICS_DATA_ROOT: rootA, AICS_APP_ROOT: rootB }, [rootA, rootB, repoData, repoAssets]);
  assert.equal(b.status, 0, b.stdout + b.stderr);
  assert.match(b.stdout, /total urls: 7 \| missing: 0 \| pending: 0 \| unverified: 0/);
  assert.ok(!b.stderr.includes('PROBE VIOLATIONS'), b.stderr);

  // c) 只有 AICS_APP_ROOT 时作为数据根。
  const c = runProbed(tempRoot, [], { AICS_APP_ROOT: rootB }, [rootA, repoData, repoAssets]);
  assert.equal(c.status, 0, c.stdout + c.stderr);
  assert.match(c.stdout, /total urls: 5 \| missing: 0 \| pending: 0 \| unverified: 0/);
  assert.ok(!c.stderr.includes('PROBE VIOLATIONS'), c.stderr);
});

test('显式素材根配置保留：AICS_CHARACTER_REF_ROOT 仍按既有含义生效', (t) => {
  const tempRoot = makeTempRoot(t);
  const rootCustom = makeRoot(tempRoot, 'root-custom', {
    refs: urlRefs(1),
    files: ['custom-refs/r1.png'],
  });
  const result = runProbed(tempRoot, ['--root', rootCustom], {
    AICS_CHARACTER_REF_ROOT: path.join(rootCustom, 'custom-refs'),
  }, [path.join(REPO_ROOT, 'data'), path.join(REPO_ROOT, 'assets')]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /total urls: 1 \| missing: 0 \| pending: 0 \| unverified: 0/);
  assert.ok(result.stdout.includes(path.join(rootCustom, 'custom-refs')),
    'refRoot 应输出显式素材根：' + result.stdout);
  assert.ok(!result.stderr.includes('PROBE VIOLATIONS'), result.stderr);
});

test('双根交叉：数据根缺失时不静默回退应用根', (t) => {
  const tempRoot = makeTempRoot(t);
  const missingData = path.join(tempRoot, 'no-such-data-root');
  const rootB = makeGoodRoot(tempRoot, 'root-b', 5);
  // 解析出的数据根不存在 → 按环境问题退出 2 并指名数据根路径；绝不静默回退应用根。
  const result = runProbed(tempRoot, [],
    { AICS_DATA_ROOT: missingData, AICS_APP_ROOT: rootB }, [rootB]);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /错误: 根目录不可用（不存在或不是目录）:/);
  assert.ok(result.stderr.includes(missingData),
    '错误应指名 AICS_DATA_ROOT 指向的缺失根：' + result.stderr);
  assert.ok(!result.stderr.includes('PROBE VIOLATIONS'), '不应回退读取 AICS_APP_ROOT：' + result.stderr);
});

test('--root 不可用（不存在或为文件）退出 2，零 view 访问', (t) => {
  const tempRoot = makeTempRoot(t);
  const plainFile = path.join(tempRoot, 'plain.txt');
  fs.writeFileSync(plainFile, 'not a root');
  const rootGood = makeGoodRoot(tempRoot, 'root-good', 1);
  const probeList = [rootGood, path.join(REPO_ROOT, 'data'), path.join(REPO_ROOT, 'assets')];
  for (const badRoot of [path.join(tempRoot, 'no-such-root'), plainFile]) {
    const result = runProbed(tempRoot, ['--root', badRoot], {}, probeList);
    assert.equal(result.status, 2, `${badRoot} 应退出 2：${result.stdout} ${result.stderr}`);
    assert.match(result.stderr, /错误: 根目录不可用（不存在或不是目录）:/);
    assert.ok(result.stderr.includes(badRoot), result.stderr);
    assert.ok(!result.stderr.includes('PROBE VIOLATIONS'), result.stderr);
  }
});

test('缺 view / 坏 JSON / 非对象表：可定位错误退出 1 且零写入', (t) => {
  const tempRoot = makeTempRoot(t);
  const rootNoData = path.join(tempRoot, 'root-nodata');
  fs.mkdirSync(rootNoData);
  const rootBadJson = makeRoot(tempRoot, 'root-badjson', { viewBody: 'not json {' });
  const rootNonObject = makeRoot(tempRoot, 'root-nonobject', { viewBody: '[]' });
  const rootBadProfile = makeRoot(tempRoot, 'root-badprofile', { viewBody: '{"broken":null}' });
  const cases = [
    { root: rootNoData, message: /ENOENT/ },
    { root: rootBadJson, message: /not valid JSON/ },
    { root: rootNonObject, message: /不是角色对象表/ },
    { root: rootBadProfile, message: /视图内容无法审计/ },
  ];
  for (const { root, message } of cases) {
    const before = fs.existsSync(root) ? snapshot(root) : {};
    const result = runProbed(tempRoot, ['--root', root], {}, [path.join(REPO_ROOT, 'data')]);
    assert.equal(result.status, 1, `${root} 应退出 1：${result.stdout} ${result.stderr}`);
    assert.match(result.stderr, /错误: 视图文件缺失或无法解析|错误: 视图文件不是角色对象表|错误: 视图内容无法审计/);
    assert.ok(!result.stderr.includes('at auditReferenceView'), 'CLI 应报告定位错误，不暴露未捕获堆栈');
    if (!/不是角色对象表/.test(result.stderr)) assert.match(result.stderr, message);
    assert.ok(result.stderr.includes(path.join(root, 'data', 'character-reference-view.json')),
      '错误应含具体路径：' + result.stderr);
    assert.deepEqual(snapshot(root), before, '失败路径不得改写夹具');
    assert.ok(!result.stderr.includes('PROBE VIOLATIONS'), result.stderr);
  }
});

test('夹具根下探针：不读生产 view/assets，成功与失败均零写入', (t) => {
  const tempRoot = makeTempRoot(t);
  const rootA = makeGoodRoot(tempRoot, 'root-a', 2);
  const rootMissing = makeRoot(tempRoot, 'root-missing', { refs: urlRefs(1), files: [] });
  const decoy = makeGoodRoot(tempRoot, 'decoy', 3);
  const repoData = path.join(REPO_ROOT, 'data');
  const repoAssets = path.join(REPO_ROOT, 'assets');

  // 成功路径：--root A + 残留 AICS_APP_ROOT=decoy（好根交叉），decoy 与生产域零访问。
  const beforeA = snapshot(rootA);
  const ok = runProbed(tempRoot, ['--root', rootA], { AICS_APP_ROOT: decoy },
    [repoData, repoAssets, decoy]);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /total urls: 2 \| missing: 0 \| pending: 0 \| unverified: 0/);
  assert.ok(!ok.stderr.includes('PROBE VIOLATIONS'), ok.stderr);
  assert.deepEqual(snapshot(rootA), beforeA, '成功路径零写入');

  // 失败路径：引用缺图如实退出 1，仍然零写入、不碰生产域。
  const beforeMissing = snapshot(rootMissing);
  const fail = runProbed(tempRoot, ['--root', rootMissing], {},
    [repoData, repoAssets, decoy]);
  assert.equal(fail.status, 1, fail.stdout + fail.stderr);
  assert.match(fail.stderr, /REFERENCE: char-x\/default: \/character-references\/r1\.png/);
  assert.ok(!fail.stderr.includes('PROBE VIOLATIONS'), fail.stderr);
  assert.deepEqual(snapshot(rootMissing), beforeMissing, '失败路径零写入');
});

test('API 签名兼容：auditReferenceView 双参默认 env 与三参显式 env 行为不变', (t) => {
  const tempRoot = makeTempRoot(t);
  const mod: typeof import('../maintenance/check-ref-urls') = require('../maintenance/check-ref-urls');
  assert.equal(typeof mod.main, 'function');
  assert.match(mod.HELP, /--root <完整项目根>/);
  const rootA = makeGoodRoot(tempRoot, 'root-a', 2);
  const rootCustom = makeRoot(tempRoot, 'root-custom', { refs: urlRefs(1), files: ['custom-refs/r1.png'] });
  const viewA = JSON.parse(fs.readFileSync(path.join(rootA, 'data', 'character-reference-view.json'), 'utf8'));
  const saved = Object.fromEntries(STRIPPED_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of STRIPPED_ENV_KEYS) delete process.env[key];
  try {
    const twoArg = mod.auditReferenceView(viewA, rootA);
    assert.equal(twoArg.missing, 0);
    assert.equal(twoArg.total, 2);
    assert.equal(twoArg.pending, 0);
    assert.equal(twoArg.refRoot, path.join(rootA, 'assets', 'character-references'));
    const viewCustom = JSON.parse(
      fs.readFileSync(path.join(rootCustom, 'data', 'character-reference-view.json'), 'utf8'));
    const threeArg = mod.auditReferenceView(viewCustom, rootCustom,
      { AICS_CHARACTER_REF_ROOT: path.join(rootCustom, 'custom-refs') });
    assert.equal(threeArg.missing, 0);
    assert.equal(threeArg.refRoot, path.join(rootCustom, 'custom-refs'));
  } finally {
    for (const key of STRIPPED_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  }
});
