'use strict';

/**
 * run-check-parallel.js —— 质量门禁并发编排器（2026-08-22）
 *
 * 取代原 `a && b && c ...` 13 步串行链。所有步骤都是只读校验（--check /
 * validate 模式不落盘），彼此无数据依赖，可安全并发。
 * 例外（2026-08-28）：数据产物不入库后，池启动前的 ensureAll(onlyIfMissing)
 * 会在产物缺失（fresh clone）时落盘构建——这只发生在本来就没有产物的机器上。
 *
 * 语义与旧链完全一致：任一步骤非零退出 → 整体失败并列出该步骤输出尾部；
 * 全部通过 → 打印每步耗时汇总。
 *
 * 并发度：CHECK_JOBS 环境变量（默认 6；重步骤已排在队列最前，
 * 低配机器可设 CHECK_JOBS=2 回退近似串行）。
 * 用法：node scripts/maintenance/run-check-parallel.js [--list]
 */

const { spawn } = (require('child_process') as typeof import('child_process'));

// 重步骤优先入队（repo 卫生 ≈50s、双 typecheck、eslint 是关键路径）。
const STEPS = [
  ['test:check', 'npm run test:check'],
  ['typecheck:app', 'npm run typecheck:app'],
  ['typecheck', 'npm run typecheck'],
  ['lint:js', 'npm run lint:js'],
  ['ts-directives', 'node scripts/maintenance/scan-ts-directives.js --check'],
  ['style-literals', 'node scripts/maintenance/scan-style-literals.js --check'],
  ['contrast', 'node scripts/maintenance/check-contrast.js --check'],
  ['colors', 'node scripts/maintenance/lint-colors.js --check'],
  ['animations', 'node scripts/maintenance/lint-animations.js --check'],
  ['scenes:build', 'node scripts/maintenance/build-scenes.js --check'],
  ['popular:build', 'node scripts/maintenance/build-popular.js --check'],
  ['blueprints:build', 'node scripts/maintenance/build-blueprints.js --check'],
  ['scenes:optimize', 'node scripts/maintenance/optimize-scenes.js --check'],
  ['scenes:ratings', 'node scripts/maintenance/classify-scene-ratings.js --check'],
  ['scenes:validate', 'node scripts/maintenance/validate-scenes.js'],
  ['content-contracts', 'node scripts/maintenance/validate-content-contracts.js'],
  ['orphan-scripts', 'node scripts/maintenance/detect-orphan-scripts.js --check'],
  ['ref-urls', 'node scripts/maintenance/check-ref-urls.js'],
  ['design:lint', 'npm run design:lint'],
];

// 数据聚合产物自 2026-08-28 起不入库：并发池启动前先补齐缺失产物（fresh clone），
// 否则 scenes:optimize / content-contracts 等读取方会与自愈构建产生缺文件竞态。
// 已构建但陈旧的状态不在这一步补 —— 交给下方 build-scenes/popular --check 报红守卫。


if (process.argv.includes('--list')) {
  for (const [name, cmd] of STEPS) console.log(`${name.padEnd(20)} ${cmd}`);
  process.exit(0);
}

(require('../lib/ensure-data-build') as typeof import('../lib/ensure-data-build')).ensureAll({ onlyIfMissing: true });

const POOL = Math.max(1, Math.min(STEPS.length, Number(process.env.CHECK_JOBS) || 6));
const results = new Map<string, { code: number; ms: number; output: string }>();
let cursor = 0;
let finished = 0;

console.log(`质量门禁并发编排：${STEPS.length} 步 / 并发 ${POOL}（CHECK_JOBS 可调）`);

function next() {
  if (cursor >= STEPS.length) return;
  const [name, cmd] = STEPS[cursor++];
  const startedAt = Date.now();
  const child = spawn(cmd, {
    shell: true,
    cwd: (require('path') as typeof import('path')).resolve(__dirname, '..', '..'),
    env: process.env,
    windowsHide: true,
  });
  let output = '';
  const capture = (chunk: Buffer | string) => { output += chunk; };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  child.on('close', (code: any) => {
    const ms = Date.now() - startedAt;
    results.set(name, { code: code ?? 1, ms, output });
    finished += 1;
    const mark = code === 0 ? '✅' : '❌';
    console.log(`  ${mark} ${name} (${(ms / 1000).toFixed(1)}s)`);
    if (finished === STEPS.length) report();
    else next();
  });
}

function report() {
  const failures = STEPS.filter(([name]: any) => (results.get(name)?.code ?? 1) !== 0);
  const wallMs = wallTime();
  console.log('');
  if (failures.length) {
    console.error(`门禁失败：${failures.length}/${STEPS.length} 步未通过（总耗时 ${(wallMs / 1000).toFixed(1)}s）：`);
    for (const [name] of failures) {
      const r = results.get(name);
      console.error(`\n──── ❌ ${name} 输出尾部 ────`);
      const tail = (r?.output || '').split(/\r?\n/).filter(Boolean).slice(-25);
      for (const line of tail) console.error('  ' + line);
    }
    process.exit(1);
  }
  const slowest = [...results.entries()]
    .sort((a: any, b: any) => b[1].ms - a[1].ms)
    .slice(0, 3)
    .map(([name, r]: any) => `${name} ${(r.ms / 1000).toFixed(1)}s`)
    .join(', ');
  console.log(`✅ 全部 ${STEPS.length} 步通过 · 总耗时 ${(wallMs / 1000).toFixed(1)}s · 最慢三步：${slowest}`);
}

const startedAtGlobal = Date.now();
function wallTime() { return Date.now() - startedAtGlobal; }

for (let i = 0; i < Math.min(POOL, STEPS.length); i += 1) next();
